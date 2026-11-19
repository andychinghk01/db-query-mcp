import { mock } from "bun:test";
import * as realFs from "node:fs";
import { dirname } from "node:path";

const scenario = process.argv[2];
const diagnostics: string[] = [];
console.error = (...args: unknown[]): void => {
  diagnostics.push(args.map(String).join(" "));
};
let closeCalls = 0;
let writes = 0;
const overrides: Record<string, unknown> = {};
if (scenario === "rename") {
  overrides.renameSync = (): never => {
    throw new Error("injected rename failure");
  };
  overrides.unlinkSync = (): never => {
    throw new Error("injected unlink failure with secret-marker");
  };
} else if (scenario === "success") {
  overrides.unlinkSync = (): never => {
    throw new Error("injected lock unlink failure");
  };
} else if (scenario === "acquire") {
  overrides.writeFileSync = (...args: Parameters<typeof realFs.writeFileSync>): void => {
    writes += 1;
    if (writes === 1) { throw new Error("injected lock write failure"); }
    realFs.writeFileSync(...args);
  };
} else if (scenario === "fd") {
  overrides.unlinkSync = (): never => {
    throw new Error("injected lock unlink failure");
  };
  overrides.closeSync = (fd: number): void => {
    closeCalls += 1;
    realFs.closeSync(fd);
  };
}
mock.module("node:fs", () => ({ ...realFs, ...overrides }));
const config = await import(`../../config.js?child=${crypto.randomUUID()}`);
try {
  if (scenario === "success") {
    const etag = config.saveConfig({ connections: [{
      name: "demo", description: "changed", host: "127.0.0.1", port: 3306,
      username: "readonly", databases: [{ name: "db", description: "DB" }],
    }] });
    console.log(JSON.stringify({
      etag,
      description: config.loadConfig().connections[0].description,
      lockDiagnostic: diagnostics.filter(
        (item) => item === "db-query-mcp: could not remove the config write lock.",
      ).length,
    }));
  } else {
    config.saveConfig(config.loadConfig());
    console.log(JSON.stringify({ thrown: undefined, lockFiles: [], closeCalls }));
  }
} catch (error) {
  const lockFiles = Array.from(new Bun.Glob("*.write.lock").scanSync(dirname(process.env.DB_QUERY_MCP_CONFIG ?? ".")));
  console.log(JSON.stringify({
    thrown: error instanceof Error ? error.message : String(error),
    tempDiagnostic: diagnostics.filter((item) => item === "db-query-mcp: could not remove a temporary config file.").length,
    lockDiagnostic: diagnostics.filter((item) => item === "db-query-mcp: could not remove the config write lock.").length,
    lockFiles,
    closeCalls,
  }));
}
