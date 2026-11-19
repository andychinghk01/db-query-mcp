import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigConflictError, readConfigWithEtag, saveConfig } from "../../config.js";

try {
  const description = process.argv[2] ?? "child";
  const id = process.argv[3] ?? "child";
  const raceDirectory = process.env.DB_QUERY_MCP_RACE_DIR;
  if (!raceDirectory) {
    throw new Error("DB_QUERY_MCP_RACE_DIR required");
  }
  const snapshot = readConfigWithEtag();
  writeFileSync(join(raceDirectory, `ready-${id}`), "ready");
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(raceDirectory, "ready-a")) || !existsSync(join(raceDirectory, "ready-b"))) {
    if (Date.now() >= deadline) {
      throw new Error("race barrier timed out");
    }
    await Bun.sleep(10);
  }
  saveConfig({
    ...snapshot.config,
    connections: snapshot.config.connections.map((item) => ({ ...item, description })),
  }, { ifMatch: snapshot.etag });
  console.log("ok");
} catch (error) {
  if (error instanceof ConfigConflictError) {
    console.log("conflict");
  } else {
    console.error(error instanceof Error ? error.message : "child failed");
    process.exitCode = 1;
  }
}
