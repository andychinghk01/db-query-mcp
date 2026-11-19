import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigConflictError, loadConfig, readConfigWithEtag, saveConfig } from "../config.js";
import { createConnection, deleteConnection, updateConnection } from "../connections-service.js";
import { resolvePassword } from "../executors.js";
import { KeychainSecretStore, MemorySecretStore, SecretMissing, setSecretStore } from "../secrets.js";
import type { ConnectionConfig } from "../types.js";

const connection: ConnectionConfig = {
  name: "fixture", description: "Fixture", host: "127.0.0.1", port: 3306,
  username: "fixture", databases: [{ name: "demo", description: "Demo" }],
};
const service = `db-query-mcp-test-${crypto.randomUUID()}`;
const native = new KeychainSecretStore(service);
const password = crypto.randomUUID();
afterAll(async () => {
  if (process.platform === "darwin") { await native.delete("probe"); }
});

afterEach(() => setSecretStore(undefined));

function fixture(fn: (path: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = process.env.TMPDIR;
    if (!root) { throw new Error("TMPDIR required"); }
    const dir = mkdtempSync(join(root, "db-query-test-"));
    const previous = process.env.DB_QUERY_MCP_CONFIG;
    const path = join(dir, "config.json");
    process.env.DB_QUERY_MCP_CONFIG = path;
    try {
      await fn(path);
    } finally {
      if (previous === undefined) {
        delete process.env.DB_QUERY_MCP_CONFIG;
      } else {
        process.env.DB_QUERY_MCP_CONFIG = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test.skipIf(process.platform !== "darwin")("isolated native Keychain round trip", async () => {
  await native.set("probe", password);
  expect(await native.get("probe") === password).toBe(true);
  expect(await native.delete("probe")).toBe(true);
  expect(await native.get("probe")).toBeNull();
}, 50_000);

test("resolvePassword reads on demand and prefers legacy passwords", async () => {
  const store = new MemorySecretStore();
  setSecretStore(store);
  await expect(resolvePassword(connection)).rejects.toBeInstanceOf(SecretMissing);
  await store.set(connection.name, password);
  expect(await resolvePassword(connection) === password).toBe(true);
  expect(await resolvePassword({ ...connection, password: "legacy" })).toBe("legacy");
  await store.delete(connection.name);
  await expect(resolvePassword(connection)).rejects.toBeInstanceOf(SecretMissing);
});

test("config preserves extensions, hardens mode, rejects a stale ETag", fixture(async (path) => {
  writeFileSync(path, JSON.stringify({ custom: true, connections: [{ ...connection, custom: 7 }] }), { mode: 0o644 });
  const { config, etag } = readConfigWithEtag();
  const next = saveConfig({ connections: [{ ...config.connections[0], environment: "prod" }] }, { ifMatch: etag });
  expect(next).not.toBe(etag);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ custom: true, connections: [{ custom: 7, environment: "prod" }] });
  expect(() => saveConfig(config, { ifMatch: etag })).toThrow(ConfigConflictError);
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, environment: "qa" }] }));
  expect(loadConfig).toThrow('invalid "environment"');
}));

test("legacy warning names the connection once and omits the password", fixture(async (path) => {
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }] }));
  const child = Bun.spawnSync([process.execPath, "-e", 'import {loadConfig} from "./src/config.js"; loadConfig(); loadConfig()'], { env: { ...process.env, DB_QUERY_MCP_KEYCHAIN_SERVICE: service } });
  expect(child.exitCode).toBe(0);
  const warning = child.stderr.toString();
  expect(warning.split("fixture")).toHaveLength(2);
  expect(warning).toContain("migrate");
  expect(warning.includes(password)).toBe(false);
}));

test("create and rename stage secrets; delete removes config before secret", fixture(async () => {
  class ObservedStore extends MemorySecretStore {
    override async set(name: string, value: string): Promise<void> {
      expect(readConfigWithEtag().config.connections.some(c => c.name === name)).toBe(false);
      await super.set(name, value);
    }
    override async delete(name: string): Promise<boolean> {
      expect(readConfigWithEtag().config.connections.some(c => c.name === name)).toBe(false);
      return super.delete(name);
    }
  }
  const store = new ObservedStore();
  let etag = await createConnection(connection, password, readConfigWithEtag().etag, store);
  etag = await updateConnection(connection.name, { ...connection, name: "renamed" }, undefined, etag, store);
  expect(await store.get("renamed") === password).toBe(true);
  await deleteConnection("renamed", etag, store);
  expect(await store.get("renamed")).toBeNull();
}));

test("config conflict rolls back a newly staged key on create and rename", fixture(async (path) => {
  class RacingStore extends MemorySecretStore {
    override async set(name: string, value: string): Promise<void> {
      await super.set(name, value);
      writeFileSync(path, JSON.stringify({ external: crypto.randomUUID(), connections: [connection] }));
    }
  }
  const store = new RacingStore();
  await expect(createConnection({ ...connection, name: "fresh" }, password, readConfigWithEtag().etag, store)).rejects.toBeInstanceOf(ConfigConflictError);
  expect(await store.get("fresh")).toBeNull();
  await expect(updateConnection(connection.name, { ...connection, name: "renamed" }, password, readConfigWithEtag().etag, store)).rejects.toBeInstanceOf(ConfigConflictError);
  expect(await store.get("renamed")).toBeNull();
  expect(loadConfig().connections[0].name).toBe(connection.name);
}));
