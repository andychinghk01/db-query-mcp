import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KeychainSecretStore } from "../secrets.js";

const service = `db-query-mcp-test-${crypto.randomUUID()}`;
afterAll(async () => {
  if (process.platform === "darwin") { await new KeychainSecretStore(service).delete("smoke"); }
});

test.skipIf(process.platform !== "darwin")("no-arg MCP stdio returns list_db with environment and handles missing secret", async () => {
  const root = process.env.TMPDIR;
  if (!root) { throw new Error("TMPDIR required"); }
  const directory = mkdtempSync(join(root, "db-query-stdio-"));
  const path = join(directory, "config.json");
  const password = crypto.randomUUID();
  writeFileSync(path, JSON.stringify({ connections: [
    { name: "smoke", description: "Smoke", host: "127.0.0.1", port: 3306, username: "fixture", environment: "stg", databases: [{ name: "demo", description: "Demo" }] },
    { name: "legacy", description: "Fixture", host: "127.0.0.1", port: 3306, username: "fixture", password, databases: [{ name: "other", description: "Other" }] },
  ] }), { mode: 0o600 });
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/index.ts"], stderr: "pipe", env: { DB_QUERY_MCP_CONFIG: path, DB_QUERY_MCP_KEYCHAIN_SERVICE: service } });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_db", "query"]);
    const list = await client.callTool({ name: "list_db" });
    const content = list.content;
    if (!Array.isArray(content) || content[0]?.type !== "text") {
      throw new Error("Expected list_db text content");
    }
    const rows: { name: string; environment: string | null }[] = JSON.parse(content[0].text);
    expect(rows.find((row) => row.name === "demo")?.environment).toBe("stg");
    expect(JSON.stringify(list).includes(password)).toBe(false);
    await client.callTool({ name: "list_db" });
    try {
      await client.callTool({ name: "query", arguments: { dbName: "demo", sql: "SELECT 1" } });
      throw new Error("Expected missing-secret error");
    } catch (error) {
      expect(String(error)).toContain("db-query-mcp set-password");
      expect(String(error).includes(password)).toBe(false);
    }
    expect(stderr.includes(password)).toBe(false);
    expect(stderr.match(/plaintext passwords in "legacy"/g)).toHaveLength(1);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
