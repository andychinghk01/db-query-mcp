import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
/**
 * Resolve the config file path.
 *
 * Precedence:
 *   1. DB_QUERY_MCP_CONFIG env var (absolute path)
 *   2. ~/.config/db-query-mcp/config.json
 *
 * ~/.config is chosen over ~/.db-query-mcp to follow the XDG Base Directory
 * Specification on macOS/Linux. The path can be overridden via env var for
 * testing or non-standard layouts.
 */
export function getConfigPath() {
    const envPath = process.env.DB_QUERY_MCP_CONFIG;
    if (envPath && envPath.trim()) {
        return envPath;
    }
    return join(homedir(), ".config", "db-query-mcp", "config.json");
}
/**
 * Load and validate the server config from disk.
 * Throws with an actionable message if the file is missing or malformed.
 */
export function loadConfig() {
    const path = getConfigPath();
    if (!existsSync(path)) {
        throw new Error(`db-query-mcp: config file not found at ${path}\n` +
            `Create it with your connections. See the README for the schema and an example.\n` +
            `You can override the path with the DB_QUERY_MCP_CONFIG env var.`);
    }
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        throw new Error(`db-query-mcp: failed to read config at ${path}: ${err}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`db-query-mcp: invalid JSON in config at ${path}: ${err}`);
    }
    return validateConfig(parsed, path);
}
function validateConfig(parsed, path) {
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`db-query-mcp: config at ${path} must be a JSON object.`);
    }
    const obj = parsed;
    const connections = obj.connections;
    if (!Array.isArray(connections)) {
        throw new Error(`db-query-mcp: config at ${path} must have a "connections" array.`);
    }
    const seenNames = new Set();
    for (const [i, conn] of connections.entries()) {
        validateConnection(conn, i, path, seenNames);
    }
    const queryTimeoutMs = typeof obj.queryTimeoutMs === "number" ? obj.queryTimeoutMs : undefined;
    const defaultRowLimit = typeof obj.defaultRowLimit === "number" ? obj.defaultRowLimit : undefined;
    if (queryTimeoutMs !== undefined && queryTimeoutMs <= 0) {
        throw new Error(`db-query-mcp: queryTimeoutMs must be positive.`);
    }
    if (defaultRowLimit !== undefined && defaultRowLimit <= 0) {
        throw new Error(`db-query-mcp: defaultRowLimit must be positive.`);
    }
    return { connections, queryTimeoutMs, defaultRowLimit };
}
function validateConnection(conn, index, path, seenNames) {
    const ctx = `connection at index ${index} in ${path}`;
    if (typeof conn !== "object" || conn === null) {
        throw new Error(`db-query-mcp: ${ctx} must be an object.`);
    }
    const c = conn;
    for (const key of ["name", "description", "host", "username", "password"]) {
        if (typeof c[key] !== "string" || c[key].length === 0) {
            throw new Error(`db-query-mcp: ${ctx} must have a string "${key}".`);
        }
    }
    if (typeof c.port !== "number" || !Number.isInteger(c.port)) {
        throw new Error(`db-query-mcp: ${ctx} must have an integer "port".`);
    }
    if (c.type !== undefined && c.type !== "mysql" && c.type !== "postgresql") {
        throw new Error(`db-query-mcp: ${ctx} has invalid "type"; must be "mysql" or "postgresql".`);
    }
    if (!Array.isArray(c.databases) || c.databases.length === 0) {
        throw new Error(`db-query-mcp: ${ctx} must have a non-empty "databases" array.`);
    }
    for (const [j, db] of c.databases.entries()) {
        if (typeof db !== "object" || db === null) {
            throw new Error(`db-query-mcp: ${ctx} database[${j}] must be an object.`);
        }
        const d = db;
        if (typeof d.name !== "string" || d.name.length === 0) {
            throw new Error(`db-query-mcp: ${ctx} database[${j}] must have a string "name".`);
        }
        if (typeof d.description !== "string") {
            throw new Error(`db-query-mcp: ${ctx} database[${j}] must have a string "description".`);
        }
    }
    const name = c.name;
    if (seenNames.has(name)) {
        throw new Error(`db-query-mcp: ${ctx} has duplicate connection name "${name}".`);
    }
    seenNames.add(name);
}
