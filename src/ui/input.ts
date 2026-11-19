import type { ConnectionConfig, DatabaseConfig } from "../types.js";

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const maxBody = 64 * 1024;

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export async function readBody(request: Request, optional = false): Promise<Record<string, unknown>> {
  const tooLarge = (): RequestError => new RequestError(413, "Request exceeds 64 KB.");
  if (Number(request.headers.get("content-length")) > maxBody) {
    throw tooLarge();
  }
  const reader = request.body?.getReader();
  if (!reader) {
    if (optional) {
      return {};
    }
    throw new RequestError(400, "Expected a JSON body.");
  }
  const buffer = new Uint8Array(maxBody);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
    if (length + chunk.value.byteLength > maxBody) {
        try {
          await reader.cancel();
        } catch {
          console.error("db-query-mcp: failed to cancel oversized request body.");
        }
        throw tooLarge();
      }
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (optional && length === 0) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch {
    throw new RequestError(400, "Invalid JSON body.");
  }
  return object(value);
}

export function connectionName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    throw new RequestError(400, "Invalid connection name.");
  }
  if (value === "__proto__" || value === "constructor" || value === "prototype") {
    throw new RequestError(400, "Invalid connection name.");
  }
  return value;
}

function text(value: unknown, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.trim().length === 0) || value.includes("\0")) {
    throw new RequestError(400, `Invalid ${field}.`);
  }
  return value;
}

export function password(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RequestError(400, "Invalid password.");
  }
  return value;
}

export function connectionFields(body: Record<string, unknown>, name = body.name): ConnectionConfig {
  const { port, type, environment } = body;
  const host = text(body.host, "host");
  if (/[\s/@?#\\]/.test(host)) {
    throw new RequestError(400, "Invalid host.");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RequestError(400, "Invalid port.");
  }
  if (type !== undefined && type !== "mysql" && type !== "postgresql") {
    throw new RequestError(400, "Invalid database engine.");
  }
  if (environment !== undefined && environment !== "dev" && environment !== "stg" && environment !== "prod") {
    throw new RequestError(400, "Invalid environment.");
  }
  if (!Array.isArray(body.databases) || body.databases.length === 0) {
    throw new RequestError(400, "At least one database is required.");
  }
  const databases = body.databases.map((entry: unknown): DatabaseConfig => {
    const item = object(entry);
    const databaseName = text(item.name, "database name");
    if (databaseName === "__proto__" || databaseName === "constructor" || databaseName === "prototype") {
      throw new RequestError(400, "Invalid database name.");
    }
    return { name: databaseName, description: text(item.description, "database description", true) };
  });
  return {
    name: connectionName(name), description: text(body.description, "description"),
    type, host, port, username: text(body.username, "username"), environment, databases,
  };
}
