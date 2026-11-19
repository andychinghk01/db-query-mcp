import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { withWriteLock } from "./lock-file.js";
import type { ServerConfig } from "./types.js";
export { ConfigLocked } from "./lock-file.js";

export function getConfigPath(): string {
  const envPath = process.env.DB_QUERY_MCP_CONFIG;
  if (envPath && envPath.trim()) {
    return envPath;
  }
  return join(homedir(), ".config", "db-query-mcp", "config.json");
}

export class ConfigConflictError extends Error {
  constructor(readonly etag: string) {
    super("Config changed. Reload it before saving.");
  }
}

export function computeEtag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readConfigBytes(): { bytes: Buffer; etag: string } {
  const bytes = readFileSync(getConfigPath());
  return { bytes, etag: computeEtag(bytes) };
}

function writeConfigBytes(bytes: Buffer): string {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.db-query-mcp-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      console.error("db-query-mcp: could not remove a temporary config file.");
    }
    throw error;
  }
  return computeEtag(bytes);
}

function withConfigWriteLock<T>(operation: () => T): T {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withWriteLock(`${path}.write.lock`, operation);
}

export function restoreConfigBytes(previous: Buffer, expectedEtag: string): string {
  return withConfigWriteLock(() => {
    const current = readConfigBytes();
    if (current.etag !== expectedEtag) {
      throw new ConfigConflictError(current.etag);
    }
    return writeConfigBytes(previous);
  });
}

let warned = false;

type ConfigSnapshot = {
  config: ServerConfig;
  etag: string;
  raw: Record<string, unknown>;
};

function read(allowMissing: boolean): ConfigSnapshot {
  const path = getConfigPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowMissing) {
        return { config: { connections: [] }, etag: computeEtag(Buffer.alloc(0)), raw: {} };
      }
      throw new Error(`db-query-mcp: config file not found at ${path}. See the README or run db-query-mcp ui.`);
    }
    throw new Error(`db-query-mcp: failed to read config at ${path}.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`db-query-mcp: invalid JSON in config at ${path}.`);
  }
  const config = validateConfig(raw, path);
  const legacy = config.connections.filter((connection) => connection.password !== undefined);
  if (!warned && legacy.length > 0) {
    warned = true;
    const names = legacy.map((connection) => JSON.stringify(connection.name)).join(", ");
    console.error(`db-query-mcp: plaintext passwords in ${names}. Run db-query-mcp migrate.`);
  }
  return { config, etag: computeEtag(bytes), raw: raw as Record<string, unknown> };
}

export function loadConfig(): ServerConfig {
  return read(false).config;
}

export function readConfigWithEtag(): { config: ServerConfig; etag: string } {
  const { config, etag } = read(true);
  return { config, etag };
}

const connectionKeys = ["name", "description", "type", "host", "port", "username", "password", "environment", "databases"] as const;

export function saveConfig(
  config: ServerConfig,
  options: { ifMatch?: string; renamed?: ReadonlyMap<string, string> } = {},
): string {
  return withConfigWriteLock(() => saveConfigUnlocked(config, options));
}

function saveConfigUnlocked(
  config: ServerConfig,
  options: { ifMatch?: string; renamed?: ReadonlyMap<string, string> },
): string {
  const path = getConfigPath();
  const current = read(true);
  if (options.ifMatch !== undefined && options.ifMatch !== current.etag) {
    throw new ConfigConflictError(current.etag);
  }
  const previous = new Map(current.config.connections.map((connection) => [connection.name, connection]));
  const connections = config.connections.map((connection) => {
    const old = previous.get(options.renamed?.get(connection.name) ?? connection.name);
    const raw: Record<string, unknown> = { ...old };
    for (const key of connectionKeys) {
      raw[key] = connection[key];
    }
    raw.databases = connection.databases.map((database) => ({
      ...old?.databases.find((item) => item.name === database.name),
      name: database.name,
      description: database.description,
    }));
    return raw;
  });
  const raw = { ...current.raw, queryTimeoutMs: config.queryTimeoutMs, defaultRowLimit: config.defaultRowLimit, connections };
  validateConfig(raw, path);
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
  return writeConfigBytes(bytes);
}

function isReservedName(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function validateConfig(parsed: unknown, path: string): ServerConfig {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`db-query-mcp: config at ${path} must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const connections = obj.connections;
  if (!Array.isArray(connections)) {
    throw new Error(`db-query-mcp: config at ${path} must have a "connections" array.`);
  }
  const seenNames = new Set<string>();
  for (const [index, connection] of connections.entries()) {
    validateConnection(connection, index, path, seenNames);
  }
  const queryTimeoutMs = typeof obj.queryTimeoutMs === "number" ? obj.queryTimeoutMs : undefined;
  const defaultRowLimit = typeof obj.defaultRowLimit === "number" ? obj.defaultRowLimit : undefined;
  if (queryTimeoutMs !== undefined && queryTimeoutMs <= 0) {
    throw new Error("db-query-mcp: queryTimeoutMs must be positive.");
  }
  if (defaultRowLimit !== undefined && defaultRowLimit <= 0) {
    throw new Error("db-query-mcp: defaultRowLimit must be positive.");
  }
  return { connections, queryTimeoutMs, defaultRowLimit };
}

function validateConnection(conn: unknown, index: number, path: string, seenNames: Set<string>): void {
  const ctx = `connection at index ${index} in ${path}`;
  if (typeof conn !== "object" || conn === null) {
    throw new Error(`db-query-mcp: ${ctx} must be an object.`);
  }
  const connection = conn as Record<string, unknown>;
  for (const key of ["name", "description", "host", "username"]) {
    if (typeof connection[key] !== "string" || connection[key].length === 0) {
      throw new Error(`db-query-mcp: ${ctx} must have a string "${key}".`);
    }
  }
  if (connection.password !== undefined && (typeof connection.password !== "string" || connection.password.length === 0)) {
    throw new Error(`db-query-mcp: ${ctx} has invalid "password".`);
  }
  if (
    connection.environment !== undefined && connection.environment !== "dev" &&
    connection.environment !== "stg" && connection.environment !== "prod"
  ) {
    throw new Error(`db-query-mcp: ${ctx} has invalid "environment"; must be dev, stg or prod.`);
  }
  if (typeof connection.port !== "number" || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
    throw new Error(`db-query-mcp: ${ctx} must have an integer "port".`);
  }
  if (connection.type !== undefined && connection.type !== "mysql" && connection.type !== "postgresql") {
    throw new Error(`db-query-mcp: ${ctx} has invalid "type"; must be "mysql" or "postgresql".`);
  }
  if (!Array.isArray(connection.databases) || connection.databases.length === 0) {
    throw new Error(`db-query-mcp: ${ctx} must have a non-empty "databases" array.`);
  }
  for (const [databaseIndex, database] of (connection.databases as unknown[]).entries()) {
    if (typeof database !== "object" || database === null) {
      throw new Error(`db-query-mcp: ${ctx} database[${databaseIndex}] must be an object.`);
    }
    const item = database as Record<string, unknown>;
    if (typeof item.name !== "string" || item.name.length === 0 || isReservedName(item.name)) {
      throw new Error(`db-query-mcp: ${ctx} database[${databaseIndex}] has an invalid or reserved name.`);
    }
    if (typeof item.description !== "string") {
      throw new Error(`db-query-mcp: ${ctx} database[${databaseIndex}] must have a string description.`);
    }
  }
  const name = connection.name as string;
  if (isReservedName(name)) {
    throw new Error(`db-query-mcp: ${ctx} uses a reserved connection name.`);
  }
  if (seenNames.has(name)) {
    throw new Error(`db-query-mcp: ${ctx} has duplicate connection name "${name}".`);
  }
  seenNames.add(name);
}
