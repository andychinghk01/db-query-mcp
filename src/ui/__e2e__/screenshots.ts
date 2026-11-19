import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemorySecretStore } from "../../secrets.js";
import { startUi } from "../server.js";

async function screenshots(): Promise<void> {
  const root = process.env.TMPDIR;
  if (!root) {
    throw new Error("TMPDIR is required");
  }
  const directory = mkdtempSync(join(root, "db-query-screenshots-"));
  const configPath = join(directory, "config.json");
  const output = join(import.meta.dir, "../../../docs/screenshots");
  const previous = process.env.DB_QUERY_MCP_CONFIG;
  process.env.DB_QUERY_MCP_CONFIG = configPath;
  let ui: Awaited<ReturnType<typeof startUi>> | undefined;
  try {
    const base = { username: "readonly", databases: [{ name: "demo", description: "Example data" }] };
    const connections = [
      { ...base, name: "stg_demo", description: "Staging sandbox", type: "mysql", host: "stg.example.com", port: 3306, environment: "stg" },
      { ...base, name: "prod_demo", description: "Production analytics", type: "postgresql", host: "prod.example.com", port: 5432, environment: "prod" },
    ];
    writeFileSync(configPath, JSON.stringify({ connections }), { mode: 0o600 });
    const store = new MemorySecretStore();
    for (const connection of connections) {
      await store.set(connection.name, crypto.randomUUID());
    }
    ui = await startUi({ store, execute: async () => undefined });
    await using view = new Bun.WebView({ width: 1200, height: 880 });
    await view.navigate(ui.url);
    for (let attempt = 0; attempt < 60 && !await view.evaluate("document.querySelectorAll('.card').length === 2"); attempt += 1) {
      await Bun.sleep(50);
    }
    if (!await view.evaluate("document.querySelectorAll('.card').length === 2")) {
      throw new Error("Demo cards did not render.");
    }
    await view.evaluate(`(() => {
      const footer = document.querySelector('#settings');
      footer.textContent = footer.textContent.replace(${JSON.stringify(configPath)}, '~/.config/db-query-mcp/config.json');
      return true;
    })()`);
    mkdirSync(output, { recursive: true });
    const capture = async (name: string): Promise<void> => {
      await Bun.sleep(220);
      await Bun.write(join(output, `${name}.png`), await view.screenshot());
      console.log(`docs/screenshots/${name}.png`);
    };
    for (const theme of ["light", "dark"]) {
      await view.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await capture(`list-${theme}`);
      await view.click(".card:first-child");
      if (!await view.evaluate("document.querySelector('#editor[open]:not(.prod)') !== null")) {
        throw new Error("Staging editor did not render.");
      }
      await capture(`editor-${theme}`);
      await view.click("#close");
      await view.click(".card:last-child");
      if (!await view.evaluate("document.querySelector('#editor.prod[open]') !== null")) {
        throw new Error("Production editor did not render.");
      }
      await capture(`prod-editor-${theme}`);
      await view.click("#close");
    }
  } finally {
    await ui?.stop();
    if (previous === undefined) {
      delete process.env.DB_QUERY_MCP_CONFIG;
    } else {
      process.env.DB_QUERY_MCP_CONFIG = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.platform === "darwin") {
  await screenshots();
} else {
  console.error("Skipping screenshots: macOS WebKit is required.");
}
