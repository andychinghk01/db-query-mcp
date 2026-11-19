import { timingSafeEqual } from "node:crypto";
import { migrate } from "../cli/migrate.js";
import { ConfigConflictError, ConfigLocked, getConfigPath, readConfigWithEtag } from "../config.js";
import {
  changePassword, ConnectionExists, ConnectionNotFound, createConnection, deleteConnection,
  findConnection, requireCurrent, updateConnection,
} from "../connections-service.js";
import { executeMysqlQuery, executePostgresQuery, sanitizeDriverError } from "../executors.js";
import { KeychainAccessDenied, KeychainTimeout, KeychainUnavailable, SecretMissing, type SecretStore } from "../secrets.js";
import type { ConnectionConfig } from "../types.js";
import { connectionFields, connectionName, password, readBody, RequestError } from "./input.js";

export type TestExecutor = (connection: ConnectionConfig, timeoutMs: number) => Promise<void>;

type Options = {
  token: string;
  port: number;
  store: SecretStore;
  touch: () => void;
  quit: () => void;
  execute?: TestExecutor;
};

async function executeTest(connection: ConnectionConfig, timeoutMs: number): Promise<void> {
  const execute = connection.type === "postgresql" ? executePostgresQuery : executeMysqlQuery;
  await execute(connection, connection.databases[0].name, "SELECT 1", [], timeoutMs, 1);
}

async function testConnection(body: Record<string, unknown>, options: Options): Promise<Response> {
  if (body.useStored !== undefined && typeof body.useStored !== "boolean") {
    throw new RequestError(400, "Invalid useStored flag.");
  }
  let connection: ConnectionConfig;
  let secret: string | undefined;
  if (body.useStored === true) {
    if (body.password !== undefined) {
      throw new RequestError(400, "Choose a draft or stored password, not both.");
    }
    connection = findConnection(readConfigWithEtag().config, connectionName(body.name));
    secret = connection.password ?? await options.store.get(connection.name) ?? undefined;
  } else {
    connection = connectionFields(body);
    secret = password(body.password);
  }
  if (secret === undefined) {
    return Response.json({ ok: false, error: "No password available. Enter or store a password first." });
  }
  const credentials = [secret, connection.username, connection.host];
  const redactions = credentials.flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (options.execute ?? executeTest)({ ...connection, password: secret }, 8_000),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Connection test timed out.")), 8_000);
      }),
    ]);
    return Response.json({ ok: true, latencyMs: Math.round(performance.now() - start) });
  } catch (error) {
    return Response.json({ ok: false, error: sanitizeDriverError(error, redactions).message });
  } finally {
    clearTimeout(timer);
  }
}

async function state(store: SecretStore): Promise<Response> {
  const { config, etag } = readConfigWithEtag();
  const connections = await Promise.all(config.connections.map(async (item) => ({
    name: item.name, description: item.description, type: item.type ?? "mysql",
    host: item.host, port: item.port, username: item.username, environment: item.environment ?? null,
    databases: item.databases.map(({ name, description }) => ({ name, description })),
    passwordState: item.password !== undefined ? "plaintext" : await store.get(item.name) === null ? "missing" : "keychain",
  })));
  return Response.json({
    connections, etag, configPath: getConfigPath(),
    plaintextCount: connections.filter((item) => item.passwordState === "plaintext").length,
    settings: { queryTimeoutMs: config.queryTimeoutMs ?? 30_000, defaultRowLimit: config.defaultRowLimit ?? 1_000 },
  });
}

export async function handleApi(request: Request, pathname: string, options: Options): Promise<Response> {
  try {
    const host = request.headers.get("host");
    if (host !== `127.0.0.1:${options.port}`) {
      throw new RequestError(403, "Invalid Host.");
    }
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      throw new RequestError(401, "Authorization required.");
    }
    const method = request.method;
    const mutation = method === "POST" || method === "PUT" || method === "DELETE";
    if (mutation && request.headers.get("origin") !== `http://127.0.0.1:${options.port}`) {
      throw new RequestError(403, "Invalid Origin.");
    }
    options.touch();
    if (method === "GET" && pathname === "/api/state") {
      return await state(options.store);
    }
    if (method === "POST" && pathname === "/api/test") {
      return await testConnection(await readBody(request), options);
    }
    const match = /^\/api\/connections\/([^/]+?)(\/password)?$/.exec(pathname);
    const collection = method === "POST" && pathname === "/api/connections";
    const migration = method === "POST" && pathname === "/api/migrate";
    const quit = method === "POST" && pathname === "/api/quit";
    if (!collection && !migration && !quit && !(match && (method === "PUT" || method === "DELETE"))) {
      throw new RequestError(404, "API route not found.");
    }
    const ifMatch = request.headers.get("if-match");
    if (!ifMatch) {
      throw new RequestError(428, "If-Match is required.");
    }
    requireCurrent(ifMatch);
    const body = await readBody(request, method === "DELETE" || migration || quit);
    if (quit) {
      requireCurrent(ifMatch);
      options.quit();
      return Response.json({ ok: true, etag: ifMatch });
    }
    if (migration) {
      const { etag } = await migrate({ ifMatch }, options.store);
      return Response.json({ etag });
    }
    if (collection) {
      const etag = await createConnection(connectionFields(body), password(body.password), ifMatch, options.store);
      return Response.json({ etag }, { status: 201 });
    }
    const name = connectionName(match?.[1]);
    if (match?.[2]) {
      const secret = method === "PUT" ? password(body.password) : undefined;
      if (method === "PUT" && secret === undefined) {
        throw new RequestError(400, "Password is required.");
      }
      return Response.json({ etag: await changePassword(name, secret, ifMatch, options.store) });
    }
    if (method === "DELETE") {
      return Response.json({ etag: await deleteConnection(name, ifMatch, options.store) });
    }
    const fields = connectionFields(body, body.newName ?? name);
    return Response.json({ etag: await updateConnection(name, fields, password(body.password), ifMatch, options.store) });
  } catch (error) {
    if (error instanceof ConfigConflictError) {
      return Response.json({ error: error.message, etag: error.etag }, { status: 409 });
    }
    if (error instanceof ConfigLocked) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof ConnectionExists) {
      return Response.json({ error: error.message, etag: readConfigWithEtag().etag }, { status: 409 });
    }
    if (error instanceof RequestError || error instanceof ConnectionNotFound) {
      return Response.json({ error: error.message }, { status: error instanceof RequestError ? error.status : 404 });
    }
    if (error instanceof KeychainTimeout || error instanceof KeychainAccessDenied || error instanceof KeychainUnavailable) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof SecretMissing) {
      return Response.json({ ok: false, error: "No stored password is available." });
    }
    return Response.json({ error: "Request failed. Check the config and run db-query-mcp doctor." }, { status: 500 });
  }
}
