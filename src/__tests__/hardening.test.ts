import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { MemorySecretStore } from "../secrets.js";
import { startUi } from "../ui/server.js";
import { readBody } from "../ui/input.js";

const base = {
  name: "valid", description: "Valid", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "database", description: "Database" }],
};

function setup(): { directory: string; path: string; previous: string | undefined } {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-hardening-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  writeFileSync(path, JSON.stringify({ connections: [] }), { mode: 0o600 });
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

test("config rejects reserved names and out-of-range ports", () => {
  const fixture = setup();
  try {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      writeFileSync(fixture.path, JSON.stringify({ connections: [{ ...base, name }] }));
      expect(() => loadConfig()).toThrow();
      writeFileSync(fixture.path, JSON.stringify({ connections: [{ ...base, databases: [{ name, description: "reserved" }] }] }));
      expect(() => loadConfig()).toThrow();
    }
    for (const port of [0, 65536, -1, 3306.5]) {
      writeFileSync(fixture.path, JSON.stringify({ connections: [{ ...base, port }] }));
      expect(() => loadConfig()).toThrow();
    }
    for (const port of [1, 3306, 65535]) {
      writeFileSync(fixture.path, JSON.stringify({ connections: [{ ...base, port }] }));
      expect(loadConfig().connections[0].port).toBe(port);
    }
  } finally {
    cleanup(fixture);
  }
});

test("API rejects reserved names and accepts valid test requests without If-Match", async () => {
  const fixture = setup();
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    ui = await startUi({ store: new MemorySecretStore(), execute: async () => undefined });
    const origin = new URL(ui.url).origin;
    const token = new URL(ui.url).hash.slice(3);
    const headers = { authorization: `Bearer ${token}`, origin };
    const stateResponse = await fetch(`${origin}/api/state`, { headers });
    const stateBody = await stateResponse.json() as { etag: string };
    const mutationHeaders = { ...headers, "if-match": stateBody.etag };
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const response = await fetch(`${origin}/api/connections`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ ...base, name }) });
      expect(response.status).toBe(400);
      const database = await fetch(`${origin}/api/connections`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ ...base, databases: [{ name, description: "bad" }] }) });
      expect(database.status).toBe(400);
    }
    const testResponse = await fetch(`${origin}/api/test`, { method: "POST", headers, body: JSON.stringify({ ...base, password: "test-only-password" }) });
    expect(testResponse.status).toBe(200);
    expect(await testResponse.json()).toMatchObject({ ok: true });
    expect((await fetch(`${origin}/api/state`, { headers: { ...headers, host: `localhost:${new URL(ui.url).port}` } })).status).toBe(403);
    expect((await fetch(`${origin}/api/state`, { headers })).status).toBe(200);
  } finally {
    await ui?.stop();
    cleanup(fixture);
  }
});

test("lock identity protects a replacement file and missing lock cleanup", async () => {
  const fixture = setup();
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    ui = await startUi({ store: new MemorySecretStore() });
    const lock = `${fixture.path}.ui.lock`;
    rmSync(lock);
    writeFileSync(lock, "replacement-lock\n");
    await ui.stop();
    expect(readFileSync(lock, "utf8")).toBe("replacement-lock\n");
    rmSync(lock);
    await ui.stop();
    const second = await startUi({ store: new MemorySecretStore(), port: Number(new URL(ui.url).port) });
    await second.stop();
  } finally {
    await ui?.stop();
    cleanup(fixture);
  }
});

test("failed UI start preserves the live instance lock", async () => {
  const fixture = setup();
  let first: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    first = await startUi({ store: new MemorySecretStore() });
    const lock = `${fixture.path}.ui.lock`;
    const contents = readFileSync(lock, "utf8");
    await expect(startUi({ port: Number(new URL(first.url).port), store: new MemorySecretStore() })).rejects.toThrow();
    expect(readFileSync(lock, "utf8")).toBe(contents);
    await first.stop();
    expect(existsSync(lock)).toBe(false);
  } finally {
    await first?.stop();
    cleanup(fixture);
  }
});

test("oversized body remains 413 when stream cancellation rejects", async () => {
  const stderr = spyOn(console, "error").mockImplementation(() => undefined);
  const marker = "body-marker-must-not-leak";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${marker}${"x".repeat(65_537)}`));
    },
    cancel() {
      return Promise.reject(new Error("injected cancel failure"));
    },
  });
  try {
    await expect(readBody(new Request("http://127.0.0.1", { method: "POST", body }))).rejects.toMatchObject({ status: 413 });
    expect(stderr.mock.calls.flat().join("\n")).toBe("db-query-mcp: failed to cancel oversized request body.");
    expect(stderr.mock.calls.flat().join("\n")).not.toContain("injected cancel failure");
    expect(stderr.mock.calls.flat().join("\n")).not.toContain(marker);
  } finally {
    stderr.mockRestore();
  }
});
