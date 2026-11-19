import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../cli/migrate.js";
import { KeychainSecretStore, MemorySecretStore } from "../secrets.js";

const service = `db-query-mcp-test-${crypto.randomUUID()}`;
const name = "cli-fixture";
const password = crypto.randomUUID();
const connection = {
  name, description: "Fixture", host: "127.0.0.1", port: 3306,
  username: "fixture", databases: [{ name: "demo", description: "Demo" }],
};

afterAll(async () => {
  if (process.platform === "darwin") {
    await new KeychainSecretStore(service).delete(name);
  }
});

function directory(): string {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  return mkdtempSync(join(root, "db-query-cli-"));
}

test("failed Keychain read-back leaves plaintext config byte-identical", async () => {
  class UnverifiedStore extends MemorySecretStore {
    override async get(): Promise<null> {
      return null;
    }
  }
  const dir = directory();
  const path = join(dir, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  try {
    const original = JSON.stringify({ connections: [{ ...connection, password }] });
    writeFileSync(path, original, { mode: 0o600 });
    await expect(migrate({}, new UnverifiedStore())).rejects.toThrow("verification failed");
    expect(readFileSync(path, "utf8") === original).toBe(true);
  } finally {
    if (previous === undefined) {
      delete process.env.DB_QUERY_MCP_CONFIG;
    } else {
      process.env.DB_QUERY_MCP_CONFIG = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("CLI migrates, reverts, sets a piped password and checks Keychain", () => {
  const dir = directory();
  const path = join(dir, "config.json");
  const read = (): string => readFileSync(path, "utf8");
  const run = (args: string[], input = ""): ReturnType<typeof Bun.spawnSync> => {
    const result = Bun.spawnSync([process.execPath, "src/index.ts", ...args], {
      env: { ...process.env, DB_QUERY_MCP_CONFIG: path, DB_QUERY_MCP_KEYCHAIN_SERVICE: service },
      stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe",
    });
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString().includes(password)).toBe(false);
    return result;
  };
  try {
    writeFileSync(path, JSON.stringify({ connections: [connection] }), { mode: 0o600 });
    const diagnosis = run(["doctor"]);
    expect(diagnosis.exitCode).toBe(1);
    expect(diagnosis.stderr?.toString()).toContain("Keychain missing");
    expect(run(["set-password", name], `${password}\n`).exitCode).toBe(1);
    expect(run(["set-password", name, "--stdin"], `${password}\n`).exitCode).toBe(0);
    expect(run(["doctor"]).exitCode).toBe(0);
    expect(run(["migrate", "--unknown"]).exitCode).toBe(2);
    writeFileSync(path, JSON.stringify({ connections: [{ ...connection, password }] }));
    const original = read();
    expect(run(["migrate", "--dry-run"]).exitCode).toBe(0);
    expect(read() === original).toBe(true);
    expect(run(["migrate"]).exitCode).toBe(0);
    const migrated = read();
    expect(migrated.includes(password) || migrated.includes('"password"')).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(run(["migrate"]).exitCode).toBe(0);
    expect(read() === migrated).toBe(true);
    expect(run(["migrate", "--revert"]).exitCode).toBe(0);
    expect(read().includes(password)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(run(["migrate"]).exitCode).toBe(0);
    expect(read() === migrated).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
