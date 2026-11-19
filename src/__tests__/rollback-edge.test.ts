import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changePassword, deleteConnection, PartialWriteError, updateConnection } from "../connections-service.js";
import { ConfigConflictError, readConfigWithEtag } from "../config.js";
import { migrate } from "../cli/migrate.js";
import { KeychainTimeout, MemorySecretStore } from "../secrets.js";
import type { ConnectionConfig } from "../types.js";

const passwords = ["edge-one-password", "edge-two-password", "edge-three-password"];
const base: ConnectionConfig = {
  name: "one", description: "One", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "db", description: "DB" }],
};

type Fixture = { directory: string; path: string; previous: string | undefined };
function fixture(): Fixture {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-edge-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  return { directory, path, previous };
}
function finish(value: Fixture): void {
  if (value.previous === undefined) {
    delete process.env.DB_QUERY_MCP_CONFIG;
  } else {
    process.env.DB_QUERY_MCP_CONFIG = value.previous;
  }
  rmSync(value.directory, { recursive: true, force: true });
}
function noSecret(error: unknown): void {
  const text = JSON.stringify(error);
  for (const password of passwords) {
    expect(text).not.toContain(password);
  }
}

class EdgeStore extends MemorySecretStore {
  calls: string[] = [];
  failSetName: string | undefined;
  failDeleteName: string | undefined;
  timeoutDeleteName: string | undefined;
  mutateDeleteName: string | undefined;
  failRestoreDeleteName: string | undefined;
  onGet: ((name: string) => void) | undefined;
  onDelete: ((name: string) => void) | undefined;
  override async get(name: string): Promise<string | null> {
    this.onGet?.(name);
    this.calls.push(`get:${name}`);
    return super.get(name);
  }
  override async set(name: string, value: string): Promise<void> {
    this.calls.push(`set:${name}`);
    await super.set(name, value);
    if (name === this.failSetName) {
      this.failSetName = undefined;
      throw new Error(`injected set failure ${name}`);
    }
  }
  override async delete(name: string): Promise<boolean> {
    this.onDelete?.(name);
    this.calls.push(`delete:${name}`);
    if (name === this.failRestoreDeleteName && this.calls.filter((call) => call === `delete:${name}`).length >= 1) {
      throw new Error(`injected compensation delete failure ${name}`);
    }
    if (name === this.timeoutDeleteName) {
      await super.delete(name);
      throw new KeychainTimeout();
    }
    if (name === this.mutateDeleteName) {
      await super.delete(name);
      throw new Error(`injected delete failure ${name}`);
    }
    if (name === this.failDeleteName) {
      throw new Error(`injected delete failure ${name}`);
    }
    return super.delete(name);
  }
}

test("migration restores first and third while reporting second compensation failure", async () => {
  const value = fixture();
  try {
    const second = { ...base, name: "two" };
    const third = { ...base, name: "three" };
    writeFileSync(value.path, JSON.stringify({ connections: [
      { ...base, password: passwords[0] }, { ...second, password: passwords[1] }, { ...third, password: passwords[2] },
    ] }));
    const store = new EdgeStore();
    store.failSetName = "three";
    store.failRestoreDeleteName = "two";
    const error = await migrate({}, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect((error as PartialWriteError).cause).toBeInstanceOf(Error);
    expect((error as PartialWriteError).compensationErrors.length).toBeGreaterThan(0);
    expect(await store.get("one")).toBeNull();
    expect(await store.get("three")).toBeNull();
    noSecret(error);
  } finally {
    finish(value);
  }
});

test("rename timeout preserves restore failure in an unknown-state error", async () => {
  const value = fixture();
  try {
    const connection = { ...base, name: "old" };
    writeFileSync(value.path, JSON.stringify({ connections: [connection] }));
    const store = new EdgeStore();
    await store.set("old", passwords[0]);
    store.timeoutDeleteName = "old";
    store.onDelete = (name) => {
      if (name === "old") {
        writeFileSync(value.path, JSON.stringify({ changed: true, connections: [connection] }));
      }
    };
    const error = await updateConnection(
      "old",
      { ...connection, name: "new" },
      undefined,
      readConfigWithEtag().etag,
      store,
    ).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect((error as PartialWriteError).message).toContain("UNKNOWN");
    expect((error as PartialWriteError).message).toContain("doctor");
    expect((error as PartialWriteError).compensationErrors.length).toBeGreaterThan(0);
    noSecret(error);
  } finally {
    finish(value);
  }
});

test("delete rejects a config change between snapshot and delete", async () => {
  const value = fixture();
  try {
    writeFileSync(value.path, JSON.stringify({ connections: [base] }));
    const store = new EdgeStore();
    store.onGet = () => writeFileSync(value.path, JSON.stringify({ changed: true, connections: [base] }));
    const before = readFileSync(value.path);
    const error = await deleteConnection("one", readConfigWithEtag().etag, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(ConfigConflictError);
    expect(readFileSync(value.path)).not.toEqual(before);
    expect(store.calls.some((call) => call.startsWith("set:") || call.startsWith("delete:"))).toBe(false);
  } finally {
    finish(value);
  }
});

test("migrate rejects a config change before writing secrets", async () => {
  const value = fixture();
  try {
    writeFileSync(value.path, JSON.stringify({ connections: [{ ...base, password: passwords[0] }] }));
    const store = new EdgeStore();
    store.onGet = () => writeFileSync(value.path, JSON.stringify({ changed: true, connections: [{ ...base, password: passwords[0] }] }));
    const error = await migrate({}, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(ConfigConflictError);
    expect(store.calls.some((call) => call.startsWith("set:") || call.startsWith("delete:"))).toBe(false);
  } finally {
    finish(value);
  }
});

test("migration timeout does not compensate the in-flight key", async () => {
  const value = fixture();
  try {
    const second = { ...base, name: "two" };
    writeFileSync(value.path, JSON.stringify({
      connections: [
        { ...base, password: passwords[0] },
        { ...second, password: passwords[1] },
      ],
    }));
    const store = new EdgeStore();
    const originalSet = store.set.bind(store);
    store.set = async (name, password) => {
      store.calls.push(`set:${name}`);
      await originalSet(name, password);
      if (name === "two") {
        throw new KeychainTimeout();
      }
    };
    const before = readFileSync(value.path);
    const error = await migrate({}, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect((error as PartialWriteError).message).toContain("UNKNOWN");
    expect((error as PartialWriteError).message).toContain("doctor");
    expect(store.calls.filter((call) => call === "delete:two" || call === "set:two").length).toBe(2);
    expect(readFileSync(value.path)).toEqual(before);
    noSecret(error);
  } finally {
    finish(value);
  }
});
