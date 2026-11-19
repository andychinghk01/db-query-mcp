import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfigWithEtag } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { startUi } from "../ui/server.js";

const draft = {
  name: "demo", description: "Demo", host: "fixture.example", port: 3306,
  username: "fixture-user", databases: [{ name: "test", description: "Test" }],
};

function fixture(run: (path: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = process.env.TMPDIR;
    if (!root) {
      throw new Error("TMPDIR required");
    }
    const directory = mkdtempSync(join(root, "db-query-ui-"));
    const path = join(directory, "config.json");
    const previous = process.env.DB_QUERY_MCP_CONFIG;
    process.env.DB_QUERY_MCP_CONFIG = path;
    try {
      await run(path);
    } finally {
      if (previous === undefined) {
        delete process.env.DB_QUERY_MCP_CONFIG;
      } else {
        process.env.DB_QUERY_MCP_CONFIG = previous;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("loopback API validates security, never echoes secrets, and orders writes", fixture(async (path) => {
  const secret = crypto.randomUUID();
  class OrderedStore extends MemorySecretStore {
    override async set(name: string, value: string): Promise<void> {
      if (name === "renamed" && await this.get("demo") !== null) {
        expect(readConfigWithEtag().config.connections.some((item) => item.name === "demo")).toBe(true);
        expect(await this.get("demo") === secret).toBe(true);
      }
      await super.set(name, value);
    }
    override async delete(name: string): Promise<boolean> {
      if (name === "demo" || name === "legacy") {
        expect(readConfigWithEtag().config.connections.some((item) => item.name === name)).toBe(false);
      }
      return super.delete(name);
    }
  }
  const store = new OrderedStore();
  const consoleErrors = spyOn(console, "error").mockImplementation(() => undefined);
  const consoleLogs = spyOn(console, "log").mockImplementation(() => undefined);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const ui = await startUi({ store, execute: async (connection, timeout) => {
      expect(timeout).toBe(8_000);
      expect(connection.password === secret).toBe(true);
      throw new Error(`Access denied: ${connection.username}@${connection.host} ${secret} ${secret}`);
    } });
    const url = new URL(ui.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("t");
    let etag = readConfigWithEtag().etag;
    const call = async (route: string, status: number, opts: RequestInit = {}): Promise<Response> => {
      const response = await fetch(`${url.origin}${route}`, opts);
      const text = await response.clone().text();
      expect(text.includes(secret) || JSON.stringify([...response.headers]).includes(secret)).toBe(false);
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      return response;
    };
    const api = async (route: string, status: number, method = "GET", data?: unknown, override: Record<string, string> = {}): Promise<Response> => {
      const response = await call(`/api/${route}`, status, {
        method,
        headers: { authorization: `Bearer ${token}`, origin: url.origin, "if-match": etag, ...override },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (response.ok) {
        const body: { etag?: string } = await response.clone().json();
        etag = body.etag ?? etag;
      }
      return response;
    };
    try {
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      const html = await call("/", 200);
      expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("cache-control")).toBe("no-store");
      expect(html.headers.get("x-content-type-options")).toBe("nosniff");
      expect(html.headers.get("referrer-policy")).toBe("no-referrer");
      await call("/api/state", 401);
      await api("state", 401, "GET", undefined, { authorization: `Bearer ${"a".repeat(64)}` });
      await api("state", 403, "GET", undefined, { host: `localhost:${url.port}` });
      await call("/api/test", 401, { method: "POST", body: "{}" });
      await api("test", 403, "POST", { ...draft, password: secret }, { host: `localhost:${url.port}` });
      await api("test", 403, "POST", { ...draft, password: secret }, { origin: "http://invalid.example" });
      await api("connections", 403, "POST", draft, { origin: "http://invalid.example" });
      await api("connections", 428, "POST", draft, { "if-match": "" });
      const stale = await api("connections", 409, "POST", draft, { "if-match": "stale" });
      expect(await stale.json()).toMatchObject({ etag });
      await api("connections", 413, "POST", { oversized: "x".repeat(65_536) });
      for (const invalid of [{ name: "bad name" }, { port: 65536 }, { host: "bad host" }, { type: "invalid" }, { environment: "invalid" }, { databases: [{}] }]) {
        await api("connections", 400, "POST", { ...draft, ...invalid });
      }
      const empty = await api("state", 200);
      expect(await empty.json()).toMatchObject({ connections: [] });
      await api("connections", 201, "POST", { ...draft, password: secret });
      expect(readFileSync(path, "utf8").includes(secret)).toBe(false);
      const state = await api("state", 200);
      expect(await state.json()).toMatchObject({ connections: [{ name: "demo", passwordState: "keychain" }] });
      const tested = await api("test", 200, "POST", { name: "demo", useStored: true });
      expect(await tested.json()).toEqual({ ok: false, error: "Access denied: [redacted]@[redacted] [redacted] [redacted]" });
      await api("test", 200, "POST", { ...draft, password: secret });
      await api("connections/demo", 200, "PUT", { ...draft, newName: "renamed", environment: "prod" });
      expect(await store.get("demo")).toBeNull();
      await api("connections/renamed/password", 200, "DELETE");
      expect(await store.get("renamed")).toBeNull();
      await api("connections/renamed/password", 200, "PUT", { password: secret });
      await api("connections/renamed", 200, "DELETE");
      expect(await store.get("renamed")).toBeNull();
      writeFileSync(path, JSON.stringify({ connections: [{ ...draft, name: "legacy", password: secret }] }));
      const legacy = await api("state", 200);
      expect(await legacy.json()).toMatchObject({ plaintextCount: 1 });
      await api("migrate", 200, "POST");
      expect(readFileSync(path, "utf8").includes(secret)).toBe(false);
      await api("connections/legacy", 200, "DELETE");
      await api("quit", 200, "POST");
      await ui.closed;
      expect(existsSync(`${path}.ui.lock`)).toBe(false);
      const logs = [...stderr.mock.calls, ...stdout.mock.calls, ...consoleErrors.mock.calls, ...consoleLogs.mock.calls].flat().map(String).join("\n");
      expect(logs.includes(secret)).toBe(false);
    } finally {
      await ui.stop();
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    consoleErrors.mockRestore();
    consoleLogs.mockRestore();
  }
}));

test("UI rejects another instance, reclaims a stale lock and shuts down when idle", fixture(async (path) => {
  const lock = `${path}.ui.lock`;
  writeFileSync(lock, '{"pid":2147483647,"port":12345}\n', { mode: 0o600 });
  const ui = await startUi({ store: new MemorySecretStore(), idleMs: 250 });
  try {
    await expect(startUi({ store: new MemorySecretStore() })).rejects.toThrow("already running");
    await ui.closed;
    expect(existsSync(lock)).toBe(false);
  } finally {
    await ui.stop();
  }
}));
