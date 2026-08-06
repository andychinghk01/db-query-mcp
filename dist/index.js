#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { isReadOnlySelect } from "./query-guard.js";
import { executeMysqlQuery, executePostgresQuery } from "./executors.js";
const QUERY_TIMEOUT_MS_DEFAULT = 30_000;
const DEFAULT_ROW_LIMIT_DEFAULT = 1_000;
const TOOLS = [
    {
        name: "list_db",
        description: "List configured MySQL and PostgreSQL databases with their names, types, and descriptions.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: "query",
        description: "Execute a read-only SELECT query against a selected MySQL or PostgreSQL database. " +
            "Supports optional parameterized values. Only SELECT/SHOW/DESCRIBE/EXPLAIN statements are allowed.",
        inputSchema: {
            type: "object",
            properties: {
                dbName: {
                    type: "string",
                    description: "The name of the database to query (as shown by list_db).",
                },
                sql: {
                    type: "string",
                    description: "A read-only SQL SELECT statement.",
                },
                params: {
                    type: "array",
                    description: "Optional positional parameters for the SQL statement. " +
                        "Use ? placeholders for MySQL or $1, $2, ... for PostgreSQL.",
                    items: {},
                },
            },
            required: ["dbName", "sql"],
            additionalProperties: false,
        },
    },
];
function resolveConnectionType(connection) {
    return connection.type ?? "mysql";
}
function findDatabase(config, name) {
    for (const connection of config.connections) {
        const database = connection.databases.find((d) => d.name === name);
        if (database) {
            return { connection, database };
        }
    }
    return undefined;
}
async function executeQuery(connection, databaseName, sql, params, timeoutMs, rowLimit) {
    const type = resolveConnectionType(connection);
    if (type === "postgresql") {
        return executePostgresQuery(connection, databaseName, sql, params, timeoutMs, rowLimit);
    }
    return executeMysqlQuery(connection, databaseName, sql, params, timeoutMs, rowLimit);
}
function textResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}
const server = new Server({ name: "db-query-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const config = loadConfig();
    const timeoutMs = config.queryTimeoutMs ?? QUERY_TIMEOUT_MS_DEFAULT;
    const rowLimit = config.defaultRowLimit ?? DEFAULT_ROW_LIMIT_DEFAULT;
    if (name === "list_db") {
        const allDatabases = config.connections.flatMap((connection) => connection.databases.map((database) => ({
            connectionName: connection.name,
            type: resolveConnectionType(connection),
            host: connection.host,
            port: connection.port,
            name: database.name,
            description: database.description,
        })));
        return textResult(allDatabases);
    }
    if (name === "query") {
        const dbName = args?.dbName;
        const sql = args?.sql;
        const params = Array.isArray(args?.params) ? args.params : [];
        if (typeof dbName !== "string" || typeof sql !== "string") {
            throw new Error("Missing required arguments: dbName and sql must be strings.");
        }
        const resolved = findDatabase(config, dbName);
        if (!resolved) {
            throw new Error(`Database "${dbName}" not found. Use list_db to see available databases.`);
        }
        if (!isReadOnlySelect(sql)) {
            throw new Error("Only read-only SELECT, SHOW, DESCRIBE, DESC, or EXPLAIN queries are allowed.");
        }
        const result = await executeQuery(resolved.connection, resolved.database.name, sql, params, timeoutMs, rowLimit);
        return textResult(result);
    }
    throw new Error(`Unknown tool: ${name}`);
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("Fatal error starting db-query-mcp:", error);
    process.exit(1);
});
