import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySecretStore } from "../secrets.js";
import { startUi } from "../ui/server.js";

const connection = {
  name: "demo", description: "Demo", host: "127.0.0.1", port: 3306,
  username: "readonly", databases: [{ name: "db", description: "DB" }],
};

test("API reports config lock contention as 503 with the fixed message", async () => {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR required");
  }
  const directory = mkdtempSync(join(root, "db-query-api-locked-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = path;
  writeFileSync(path, JSON.stringify({ connections: [] }), { mode: 0o600 });
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    ui = await startUi({ store: new MemorySecretStore() });
    const url = new URL(ui.url);
    const token = url.hash.slice(3);
    const state = await fetch(`${url.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    const stateBody = await state.json() as { etag: string };
    writeFileSync(`${path}.write.lock`, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
    const response = await fetch(`${url.origin}/api/connections`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: url.origin,
        "if-match": stateBody.etag,
        "content-type": "application/json",
      },
      body: JSON.stringify(connection),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Another db-query-mcp process is writing the config. Try again." });
  } finally {
    await ui?.stop();
    if (previous === undefined) {
      delete process.env.DB_QUERY_MCP_CONFIG;
    } else {
      process.env.DB_QUERY_MCP_CONFIG = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
