import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changePassword, createConnection, deleteConnection, PartialWriteError, stagedWrite, updateConnection } from "../connections-service.js";
import { readConfigBytes, readConfigWithEtag } from "../config.js";
import { migrate } from "../cli/migrate.js";
import { MemorySecretStore, KeychainTimeout } from "../secrets.js";
import type { ConnectionConfig } from "../types.js";

const password = "rollback-test-password";
const connection: ConnectionConfig = {
  name: "demo", description: "Demo", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "database", description: "Database" }],
};

class FailingSecretStore extends MemorySecretStore {
  failDeleteNames = new Set<string>();
  failSetAt = new Set<number>();
  mutateThenRejectSet = new Set<string>();
  mutateThenRejectDelete = new Set<string>();
  timeoutDelete = new Set<string>();
  setCount = 0;
  onDelete: ((name: string) => void) | undefined;

  override async set(name: string, value: string): Promise<void> {
    this.setCount += 1;
    if (this.failSetAt.has(this.setCount)) {
      throw new Error(`injected set failure ${this.setCount}`);
    }
    await super.set(name, value);
    if (this.mutateThenRejectSet.has(name)) {
      this.mutateThenRejectSet.delete(name);
      throw new Error(`injected set-after-apply failure ${name}`);
    }
  }

  override async delete(name: string): Promise<boolean> {
    this.onDelete?.(name);
    if (this.timeoutDelete.has(name)) {
      await super.delete(name);
      throw new KeychainTimeout();
    }
    if (this.mutateThenRejectDelete.has(name)) {
      await super.delete(name);
      throw new Error(`injected delete-after-apply failure ${name}`);
    }
    if (this.failDeleteNames.has(name)) {
      throw new Error(`injected delete failure ${name}`);
    }
    return super.delete(name);
  }
}

class MismatchingStore extends MemorySecretStore {
  override async get(name: string): Promise<string | null> {
    const value = await super.get(name);
    return value === null ? null : `${value}-wrong`;
  }
}

function fixture(run: (path: string, directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = process.env.TMPDIR;
    if (!root) {
      throw new Error("TMPDIR required");
    }
    const directory = mkdtempSync(join(root, "db-query-rollback-"));
    const path = join(directory, "config.json");
    const previous = process.env.DB_QUERY_MCP_CONFIG;
    process.env.DB_QUERY_MCP_CONFIG = path;
    try {
      await run(path, directory);
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

function seed(path: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(path, JSON.stringify({ topLevelUnknown: "preserve", connections: [{ ...connection, perConnectionUnknown: 7 }], ...extra }, null, 2), { mode: 0o600 });
}

afterEach(() => {
  delete process.env.DB_QUERY_MCP_CONFIG;
});

test("rename rolls back config and secrets when old-secret deletion fails", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.failDeleteNames.add("demo");
  const before = readFileSync(path);
  const etag = readConfigWithEtag().etag;
  const error = new Error("original old-delete failure");
  store.onDelete = (name) => {
    if (name === "demo") {
      throw error;
    }
  };
  await expect(updateConnection("demo", { ...connection, name: "renamed" }, undefined, etag, store)).rejects.toBe(error);
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
  expect(await store.get("renamed")).toBeNull();
  expect(error.message.includes(password)).toBe(false);
}));

test("delete restores unknown config bytes when secret deletion fails", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.failDeleteNames.add("demo");
  const before = readFileSync(path);
  await expect(deleteConnection("demo", readConfigWithEtag().etag, store)).rejects.toThrow("injected delete failure");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
}));

test("password removal restores config when secret deletion fails", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.failDeleteNames.add("demo");
  const before = readFileSync(path);
  await expect(changePassword("demo", undefined, readConfigWithEtag().etag, store)).rejects.toThrow("injected delete failure");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
}));

test("delete reports the original cause when config restoration also fails", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  const original = new Error("original delete error");
  store.onDelete = () => {
    writeFileSync(path, JSON.stringify({ changed: true, connections: [{ ...connection, name: "external" }] }));
    throw original;
  };
  const error = await deleteConnection("demo", readConfigWithEtag().etag, store).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PartialWriteError);
  expect((error as PartialWriteError).cause).toBe(original);
  expect((error as PartialWriteError).compensationErrors.length).toBeGreaterThan(0);
  expect(JSON.stringify(error).includes(password)).toBe(false);
}));

test("stagedWrite exposes original and rollback failures", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  store.failDeleteNames.add("new-secret");
  const original = new Error("original config conflict");
  const error = await stagedWrite(store, "new-secret", password, () => {
    throw original;
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PartialWriteError);
  expect((error as PartialWriteError).cause).toBe(original);
  expect((error as PartialWriteError).compensationErrors).toHaveLength(1);
  expect(JSON.stringify(error).includes(password)).toBe(false);
}));

test("migrate rolls back earlier secrets when a later set fails", fixture(async (path) => {
  seed(path);
  const second = { ...connection, name: "second" };
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }, { ...second, password: "second-password" }] }), { mode: 0o600 });
  const store = new FailingSecretStore();
  store.failSetAt.add(2);
  const before = readFileSync(path);
  await expect(migrate({}, store)).rejects.toThrow("injected set failure");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBeNull();
}));

test("migrate rolls back a read-back mismatch", fixture(async (path) => {
  seed(path);
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }] }), { mode: 0o600 });
  const store = new MismatchingStore();
  const before = readFileSync(path);
  await expect(migrate({}, store)).rejects.toThrow("verification failed");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBeNull();
}));

test("migrate rolls back secrets after an ETag conflict", fixture(async (path) => {
  seed(path);
  const second = { ...connection, name: "second" };
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }, { ...second, password: "second-password" }] }), { mode: 0o600 });
  class ConflictStore extends FailingSecretStore {
    override async set(name: string, value: string): Promise<void> {
      await super.set(name, value);
      if (name === "second") {
        writeFileSync(path, JSON.stringify({ externallyChanged: true, connections: [{ ...connection, password }, { ...second, password: "second-password" }] }));
      }
    }
  }
  const store = new ConflictStore();
  const before = readFileSync(path);
  await expect(migrate({}, store)).rejects.toThrow();
  expect(readFileSync(path)).not.toEqual(before);
  expect(await store.get("demo")).toBeNull();
  expect(await store.get("second")).toBeNull();
}));

test("rename restores a new secret when set mutates then rejects", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.mutateThenRejectSet.add("renamed");
  const before = readFileSync(path);
  await expect(updateConnection("demo", { ...connection, name: "renamed" }, "new-password", readConfigWithEtag().etag, store)).rejects.toThrow("set-after-apply");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
  expect(await store.get("renamed")).toBeNull();
}));

test("rename restores the old secret when delete mutates then rejects", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.mutateThenRejectDelete.add("demo");
  const before = readFileSync(path);
  await expect(updateConnection("demo", { ...connection, name: "renamed" }, undefined, readConfigWithEtag().etag, store)).rejects.toThrow("delete-after-apply");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
  expect(await store.get("renamed")).toBeNull();
}));

test("delete restores a secret when delete mutates then rejects", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.mutateThenRejectDelete.add("demo");
  const before = readFileSync(path);
  await expect(deleteConnection("demo", readConfigWithEtag().etag, store)).rejects.toThrow("delete-after-apply");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
}));

test("password removal restores a secret when delete mutates then rejects", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.mutateThenRejectDelete.add("demo");
  const before = readFileSync(path);
  await expect(changePassword("demo", undefined, readConfigWithEtag().etag, store)).rejects.toThrow("delete-after-apply");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBe(password);
}));

test("migrate restores pre-existing secrets after a mutating set rejection", fixture(async (path) => {
  const second = { ...connection, name: "second" };
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }, { ...second, password: "new-second" }] }), { mode: 0o600 });
  const store = new FailingSecretStore();
  await store.set("second", "old-second");
  store.mutateThenRejectSet.add("second");
  const before = readFileSync(path);
  await expect(migrate({}, store)).rejects.toThrow("set-after-apply");
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBeNull();
  expect(await store.get("second")).toBe("old-second");
}));

test("delete timeout restores config but reports unknown secret state", fixture(async (path) => {
  seed(path);
  const store = new FailingSecretStore();
  await store.set("demo", password);
  store.timeoutDelete.add("demo");
  const before = readFileSync(path);
  const error = await deleteConnection("demo", readConfigWithEtag().etag, store).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PartialWriteError);
  expect((error as PartialWriteError).cause).toBeInstanceOf(KeychainTimeout);
  expect((error as PartialWriteError).message).toContain("UNKNOWN");
  expect((error as PartialWriteError).message).toContain("doctor");
  expect(readFileSync(path)).toEqual(before);
  expect(JSON.stringify(error).includes(password)).toBe(false);
}));

test("migrate rolls back secrets when config directory becomes unwritable", fixture(async (path, directory) => {
  const second = { ...connection, name: "second" };
  writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }, { ...second, password: "second-password" }] }), { mode: 0o600 });
  const store = new MemorySecretStore();
  const before = readFileSync(path);
  chmodSync(directory, 0o500);
  try {
    await expect(migrate({}, store)).rejects.toThrow();
  } finally {
    chmodSync(directory, 0o700);
  }
  expect(readFileSync(path)).toEqual(before);
  expect(await store.get("demo")).toBeNull();
  expect(await store.get("second")).toBeNull();
}));
