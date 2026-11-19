import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySecretStore } from "../../secrets.js";
import { startUi } from "../server.js";

const legacy = {
  name: "legacy_demo", description: "Legacy demo", type: "mysql",
  host: "stg.example.com", port: 3306, username: "readonly",
  environment: "stg", databases: [{ name: "demo", description: "Demo database" }],
};

if (process.platform !== "darwin") {
  console.error("Skipping WebView e2e: macOS WebKit is required.");
}

test.skipIf(process.platform !== "darwin")("WebView manages connections without exposing passwords", async () => {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR is required");
  }
  const directory = mkdtempSync(join(root, "db-query-e2e-"));
  const path = join(directory, "config.json");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  const password = `fake-${crypto.randomUUID()}`;
  process.env.DB_QUERY_MCP_CONFIG = path;
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    let fail = false;
    ui = await startUi({ store: new MemorySecretStore(), execute: async (connection) => {
      expect(connection.password === password).toBe(true);
      if (fail) {
        throw new Error(`Access denied for ${connection.username}@${connection.host}; password=${password}`);
      }
    } });
    const errors: string[] = [];
    await using view = new Bun.WebView({ width: 1180, height: 900, console: (kind) => {
      if (kind === "error") {
        errors.push(kind);
      }
    } });
    const wait = async (condition: string): Promise<void> => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (await view.evaluate<boolean>(condition)) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error(`Timed out waiting for ${condition}`);
    };
    const set = async (selector: string, value: string): Promise<void> => {
      await view.evaluate(`(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        field.value = ${JSON.stringify(value)};
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    };
    const noLeak = async (): Promise<void> => {
      expect(await view.evaluate<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(password)})`)).toBe(false);
      expect(readFileSync(path, "utf8").includes(password)).toBe(false);
    };

    await view.navigate(ui.url);
    await wait("!document.querySelector('#add').disabled && !document.querySelector('#empty').hidden");
    expect(await view.evaluate("document.querySelector('#empty').textContent")).toContain("workspace is empty");
    expect(await view.evaluate("location.hash")).toBe("");
    await view.click("#add");
    await wait("document.querySelector('#editor').open");
    await view.click("#name");
    await view.type("stg_demo");
    await set("#description", "Staging demo");
    await set("#host", legacy.host);
    await set("#username", legacy.username);
    await set("#environment", "stg");
    await set("#password", password);
    await set("[data-field=name]", "demo");
    await set("[data-field=description]", "Demo database");
    await view.click("#save");
    await wait("document.querySelector('.card .keychain') !== null");
    await noLeak();

    await view.click(".card");
    await wait("document.querySelector('#editor').open");
    expect(await view.evaluate("document.querySelector('#password').value")).toBe("");
    await set("#description", "Production demo");
    await set("#environment", "prod");
    await view.click("#save");
    await wait("!document.querySelector('#editor').open && document.querySelector('.card .prod')?.textContent === 'PROD'");
    await view.click(".card");
    await wait("document.querySelector('#editor.prod[open]') !== null");
    await set("#name", "prod_demo");
    await view.click("#save");
    await wait("!document.querySelector('#editor').open && document.querySelector('.card-name')?.textContent === 'prod_demo'");
    await noLeak();

    await view.click(".card");
    await view.click("#test");
    await wait("document.querySelector('#test-result').textContent.includes('Connected')");
    fail = true;
    await view.click("#test");
    await wait("document.querySelector('#test-result').textContent.includes('[redacted]')");
    expect(await view.evaluate("document.querySelector('#test-result').textContent")).toBe("Access denied for [redacted]@[redacted]; password=[redacted]");
    await noLeak();

    await view.click("#delete");
    await wait("!document.querySelector('#delete-confirm').hidden");
    await set("#confirmation", "wrong");
    expect(await view.evaluate("document.querySelector('#confirm-delete').disabled")).toBe(true);
    await set("#confirmation", "prod_demo");
    expect(await view.evaluate("document.querySelector('#confirm-delete').disabled")).toBe(false);
    await view.evaluate("document.querySelector('#confirm-delete').click()");
    await wait("!document.querySelector('#editor').open && document.querySelector('.card') === null");
    await noLeak();

    await view.click("#add");
    await wait("document.querySelector('#editor').open");
    await set("#name", "draft");
    await set("#description", "Unsaved draft");
    await set("#host", legacy.host);
    await set("#username", legacy.username);
    await set("[data-field=name]", "demo");
    writeFileSync(path, JSON.stringify({ connections: [{ ...legacy, password }] }), { mode: 0o600 });
    await view.click("#save");
    await wait("!document.querySelector('#editor-conflict').hidden");
    expect(await view.evaluate("document.querySelector('#editor-conflict').textContent")).toContain("Configuration changed");
    await view.evaluate("window.confirm = () => true");
    await view.click("#editor-reload");
    await wait("!document.querySelector('#editor').open && !document.querySelector('#legacy').hidden");
    expect(await view.evaluate("document.querySelector('#migrate').textContent")).toBe("Move 1 password to Keychain");
    expect(await view.evaluate<boolean>(`document.documentElement.outerHTML.includes(${JSON.stringify(password)})`)).toBe(false);
    await view.click("#migrate");
    await wait("document.querySelector('#legacy').hidden && document.querySelector('.card .keychain') !== null");
    await noLeak();
    await view.click(".card");
    await wait("document.querySelector('#editor').open");
    await view.press("Escape");
    await wait("!document.querySelector('#editor').open");
    expect(errors).toEqual([]);
  } finally {
    await ui?.stop();
    if (previous === undefined) {
      delete process.env.DB_QUERY_MCP_CONFIG;
    } else {
      process.env.DB_QUERY_MCP_CONFIG = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
