import { parseArgs } from "node:util";
import { changePassword } from "./connections-service.js";
import { doctor } from "./cli/doctor.js";
import { migrate } from "./cli/migrate.js";
import { readPassword } from "./cli/password.js";

const help = `Usage: db-query-mcp [command]
  ui [--port N] [--no-open]
  migrate [--dry-run] [--revert]
  set-password <name> [--stdin]
  doctor
  --help`;

function usage(): number {
  console.error(help);
  return 2;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" && args.length === 0) {
    console.error(help);
    return 0;
  }
  const options: NonNullable<Parameters<typeof parseArgs>[0]>["options"] = command === "migrate" ? {
    "dry-run": { type: "boolean" }, revert: { type: "boolean" },
  } as const : command === "set-password" ? {
    stdin: { type: "boolean" },
  } as const : command === "ui" ? {
    port: { type: "string" }, "no-open": { type: "boolean" },
  } as const : {};
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true });
  } catch {
    return usage();
  }
  const { values, positionals } = parsed;
  if (command === "migrate" && positionals.length === 0) {
    const dryRun = values["dry-run"] === true;
    const revert = values.revert === true;
    const { names } = await migrate({ dryRun, revert });
    if (revert && !dryRun && names.length > 0) {
      console.error("Warning: passwords are now stored in plaintext in the config file.");
    }
    const action = revert ? "restore to config" : "move to Keychain";
    const targets = names.map((name) => JSON.stringify(name)).join(", ");
    console.error(names.length ? `${dryRun ? "Dry run: would" : "Completed:"} ${action}: ${targets}` : "No passwords to move.");
    return 0;
  }
  if (command === "set-password" && positionals.length === 1 && positionals[0]) {
    const password = await readPassword(values.stdin === true);
    if (password.length === 0) {
      throw new Error("Password must not be empty.");
    }
    await changePassword(positionals[0], password);
    console.error("Password stored in Keychain.");
    return 0;
  }
  if (command === "doctor" && positionals.length === 0) {
    return await doctor() ? 0 : 1;
  }
  if (command === "ui" && positionals.length === 0) {
    const input = values.port;
    const port = input === undefined ? 0 : Number(input);
    if (input !== undefined && (typeof input !== "string" || !/^\d+$/.test(input) || port < 1 || port > 65535)) {
      return usage();
    }
    const { startUi } = await import("./ui/server.js");
    const ui = await startUi({ port });
    console.error(ui.url);
    if (values["no-open"] !== true && process.platform === "darwin") {
      const opener = Bun.spawn(["open", ui.url], { stdout: "ignore", stderr: "ignore" });
      if (await opener.exited !== 0) {
        console.error("Open the URL above in your browser.");
      }
    }
    await ui.closed;
    return 0;
  }
  return usage();
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
}
