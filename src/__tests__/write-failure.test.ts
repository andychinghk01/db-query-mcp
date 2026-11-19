import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fixture(): { directory: string; path: string; previous: string | undefined } {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-write-failure-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  writeFileSync(path, JSON.stringify({ connections: [{
    name: "demo", description: "Demo", host: "127.0.0.1", port: 3306,
    username: "readonly", databases: [{ name: "db", description: "DB" }],
  }] }));
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
function runChild(path: string, scenario: string): { output: Record<string, unknown>; stderr: string } {
  const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/write-failure-child.ts`, scenario], {
    env: { ...process.env, DB_QUERY_MCP_CONFIG: path }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return { output: JSON.parse(result.stdout.toString()), stderr: result.stderr.toString() };
}

test("rename failure preserves original error and both cleanup diagnostics", () => {
  const value = fixture();
  try {
    const result = runChild(value.path, "rename");
    expect(result.output.thrown).toBe("injected rename failure");
    expect(result.output.tempDiagnostic).toBe(1);
    expect(result.output.lockDiagnostic).toBe(1);
    expect(result.stderr).not.toContain("secret-marker");
    expect(result.stderr).not.toContain(value.path);
  } finally {
    cleanup(value);
  }
});

test("successful save returns its etag when lock unlink fails", () => {
  const value = fixture();
  try {
    const result = runChild(value.path, "success");
    expect(typeof result.output.etag).toBe("string");
    expect(result.output.description).toBe("changed");
    expect(result.output.lockDiagnostic).toBe(1);
  } finally {
    cleanup(value);
  }
});

test("lock acquisition write failure removes its lock", () => {
  const value = fixture();
  try {
    const result = runChild(value.path, "acquire");
    expect(result.output.thrown).toBe("injected lock write failure");
    expect(result.output.lockFiles).toEqual([]);
  } finally {
    cleanup(value);
  }
});

test("lock fd closes when lock unlink fails", () => {
  const value = fixture();
  try {
    const result = runChild(value.path, "fd");
    expect(result.output.closeCalls).toBeGreaterThan(0);
  } finally {
    cleanup(value);
  }
});
