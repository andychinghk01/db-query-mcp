import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changePassword, deleteConnection, PartialWriteError } from "../connections-service.js";
import { readConfigWithEtag } from "../config.js";
import { KeychainTimeout, MemorySecretStore } from "../secrets.js";
import type { ConnectionConfig } from "../types.js";

const password = "timeout-restore-password";
const connection: ConnectionConfig = {
  name: "demo", description: "Demo", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "db", description: "DB" }],
};

class TimeoutStore extends MemorySecretStore {
  calls = 0;
  onDelete: (() => void) | undefined;
  override async delete(name: string): Promise<boolean> {
    this.calls += 1;
    this.onDelete?.();
    await super.delete(name);
    throw new KeychainTimeout();
  }
}

function setup(): { directory: string; path: string; previous: string | undefined } {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-timeout-restore-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  writeFileSync(path, JSON.stringify({ connections: [connection] }));
  return { directory, path, previous };
}

function cleanup(value: { directory: string; previous: string | undefined }): void {
  if (value.previous === undefined) {
    delete process.env.DB_QUERY_MCP_CONFIG;
  } else {
    process.env.DB_QUERY_MCP_CONFIG = value.previous;
  }
  rmSync(value.directory, { recursive: true, force: true });
}

function assertNoSecret(error: unknown): void {
  expect(JSON.stringify(error)).not.toContain(password);
  expect((error as PartialWriteError).message).not.toContain(password);
  expect(String((error as PartialWriteError).cause)).not.toContain(password);
  for (const item of (error as PartialWriteError).compensationErrors) {
    expect(String(item)).not.toContain(password);
  }
}

test("delete timeout with restore conflict reports unknown state and compensation", async () => {
  const value = setup();
  try {
    const store = new TimeoutStore();
    await store.set("demo", password);
    store.onDelete = () => {
      writeFileSync(value.path, JSON.stringify({ changed: true, connections: [connection] }));
    };
    const error = await deleteConnection("demo", readConfigWithEtag().etag, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect((error as PartialWriteError).cause).toBeInstanceOf(KeychainTimeout);
    expect((error as PartialWriteError).message).toContain("UNKNOWN");
    expect((error as PartialWriteError).message).toContain("doctor");
    const hasConflict = (error as PartialWriteError).compensationErrors.some(
      (item) => item instanceof Error && item.message.includes("Config changed"),
    );
    expect(hasConflict).toBe(true);
    assertNoSecret(error);
  } finally {
    cleanup(value);
  }
});

test("password removal timeout with restore conflict reports unknown state and compensation", async () => {
  const value = setup();
  try {
    const store = new TimeoutStore();
    await store.set("demo", password);
    store.onDelete = () => {
      writeFileSync(value.path, JSON.stringify({ changed: true, connections: [connection] }));
    };
    const error = await changePassword("demo", undefined, readConfigWithEtag().etag, store).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(PartialWriteError);
    expect((error as PartialWriteError).cause).toBeInstanceOf(KeychainTimeout);
    expect((error as PartialWriteError).message).toContain("UNKNOWN");
    expect((error as PartialWriteError).message).toContain("doctor");
    const hasConflict = (error as PartialWriteError).compensationErrors.some(
      (item) => item instanceof Error && item.message.includes("Config changed"),
    );
    expect(hasConflict).toBe(true);
    assertNoSecret(error);
  } finally {
    cleanup(value);
  }
});
