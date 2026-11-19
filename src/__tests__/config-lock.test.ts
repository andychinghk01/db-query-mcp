import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigLocked, readConfigBytes, readConfigWithEtag, restoreConfigBytes, saveConfig } from "../config.js";

const connection = {
  name: "demo", description: "Demo", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "database", description: "Database" }],
};

function fixture(): { directory: string; path: string; previous: string | undefined } {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-lock-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  writeFileSync(path, JSON.stringify({ connections: [connection] }), { mode: 0o600 });
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

test("held live write lock fails without changing config", () => {
  const fixtureValue = fixture();
  try {
    const lock = `${fixtureValue.path}.write.lock`;
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    const before = readFileSync(fixtureValue.path);
    const changed = { connections: [{ ...connection, description: "changed" }] };
    expect(() => saveConfig(changed, { ifMatch: readConfigWithEtag().etag })).toThrow(ConfigLocked);
    expect(readFileSync(fixtureValue.path)).toEqual(before);
    expect(existsSync(lock)).toBe(true);
  } finally {
    cleanup(fixtureValue);
  }
}, 5_000);

test("stale write lock is reclaimed and removed after success", () => {
  const fixtureValue = fixture();
  try {
    const lock = `${fixtureValue.path}.write.lock`;
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    saveConfig({ connections: [{ ...connection, description: "changed" }] }, { ifMatch: readConfigWithEtag().etag });
    expect(existsSync(lock)).toBe(false);
  } finally {
    cleanup(fixtureValue);
  }
});

test("restore observes the held lock and does not remove a replacement", () => {
  const fixtureValue = fixture();
  try {
    const lock = `${fixtureValue.path}.write.lock`;
    const snapshot = readConfigBytes();
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    expect(() => restoreConfigBytes(snapshot.bytes, snapshot.etag)).toThrow(ConfigLocked);
    expect(readFileSync(lock, "utf8")).toContain(String(process.pid));
    rmSync(lock);
    writeFileSync(lock, "replacement\n");
    expect(() => restoreConfigBytes(snapshot.bytes, snapshot.etag)).toThrow(ConfigLocked);
    expect(readFileSync(lock, "utf8")).toBe("replacement\n");
  } finally {
    cleanup(fixtureValue);
  }
}, 5_000);

test("old pidless lock is reclaimed while a fresh pidless lock is held", () => {
  const fixtureValue = fixture();
  try {
    const lock = `${fixtureValue.path}.write.lock`;
    writeFileSync(lock, "");
    const old = Date.now() - 6_000;
    utimesSync(lock, old / 1000, old / 1000);
    saveConfig({ connections: [{ ...connection, description: "reclaimed" }] }, { ifMatch: readConfigWithEtag().etag });
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, "");
    const blocked = { connections: [{ ...connection, description: "blocked" }] };
    expect(() => saveConfig(blocked, { ifMatch: readConfigWithEtag().etag })).toThrow(ConfigLocked);
  } finally {
    cleanup(fixtureValue);
  }
}, 5_000);

test("real subprocess saves produce one success and one conflict", async () => {
  const fixtureValue = fixture();
  try {
    const script = `${import.meta.dir}/fixtures/save-race.ts`;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      writeFileSync(fixtureValue.path, JSON.stringify({ connections: [connection] }), { mode: 0o600 });
      const raceDirectory = join(fixtureValue.directory, `race-${iteration}`);
      mkdirSync(raceDirectory);
      const env = {
        ...process.env,
        DB_QUERY_MCP_CONFIG: fixtureValue.path,
        DB_QUERY_MCP_RACE_DIR: raceDirectory,
      };
      const first = Bun.spawn([process.execPath, script, `child-${iteration}-a`, "a"], { env, stdout: "pipe", stderr: "pipe" });
      const second = Bun.spawn([process.execPath, script, `child-${iteration}-b`, "b"], { env, stdout: "pipe", stderr: "pipe" });
      const [firstOutput, secondOutput] = await Promise.all([
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
      ]);
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      expect([firstOutput.trim(), secondOutput.trim()].sort()).toEqual(["conflict", "ok"]);
      const parsed = JSON.parse(readFileSync(fixtureValue.path, "utf8")) as { connections: unknown[] };
      expect(parsed.connections).toHaveLength(1);
      expect(Array.from(new Bun.Glob("*.tmp").scanSync(fixtureValue.directory))).toEqual([]);
      expect(Array.from(new Bun.Glob("*.write.lock").scanSync(fixtureValue.directory))).toEqual([]);
    }
  } finally {
    cleanup(fixtureValue);
  }
});
