import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { isReadOnlySelect } from "./query-guard.js";
import { executeMysqlQuery, executePostgresQuery } from "./executors.js";
import { findDatabase } from "./resolve.js";
import type { ConnectionConfig, QueryResult } from "./types.js";

const QUERY_TIMEOUT_MS_DEFAULT = 30_000;
const DEFAULT_ROW_LIMIT_DEFAULT = 1_000;

const TOOLS: Tool[] = [
  {
    name: "list_db",
    description:
      "List configured MySQL and PostgreSQL databases with their names, types, and descriptions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description:
      "Execute a read-only SELECT query against a selected MySQL or PostgreSQL database. " +
      "Supports optional parameterized values. Only SELECT/SHOW/DESCRIBE/EXPLAIN statements are allowed. " +
      "If the same dbName exists on several connections (e.g. staging and prod), pass connectionName to choose one.",
    inputSchema: {
      type: "object",
      properties: {
        dbName: {
          type: "string",
          description:
            "The name of the database to query (as shown by list_db). " +
            "If several connections expose this name, also pass connectionName.",
        },
        connectionName: {
          type: "string",
          description:
            "Optional connection name (connectionName column from list_db). " +
            "Required to disambiguate when the same dbName exists on several connections.",
        },
        sql: {
          type: "string",
          description: "A read-only SQL SELECT statement.",
        },
        params: {
          type: "array",
          description:
            "Optional positional parameters for the SQL statement. " +
            "Use ? placeholders for MySQL or $1, $2, ... for PostgreSQL.",
          items: {},
        },
      },
      required: ["dbName", "sql"],
      additionalProperties: false,
    },
  },
];

function resolveConnectionType(connection: ConnectionConfig): "mysql" | "postgresql" {
  return connection.type ?? "mysql";
}

async function executeQuery(
  connection: ConnectionConfig,
  databaseName: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<QueryResult> {
  const type = resolveConnectionType(connection);
  if (type === "postgresql") {
    return executePostgresQuery(
      connection,
      databaseName,
      sql,
      params,
      timeoutMs,
      rowLimit,
    );
  }
  return executeMysqlQuery(
    connection,
    databaseName,
    sql,
    params,
    timeoutMs,
    rowLimit,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new Server(
  { name: "db-query-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }) => {
    const { name, arguments: args } = request.params;
    const config = loadConfig();
    const timeoutMs = config.queryTimeoutMs ?? QUERY_TIMEOUT_MS_DEFAULT;
    const rowLimit = config.defaultRowLimit ?? DEFAULT_ROW_LIMIT_DEFAULT;

    if (name === "list_db") {
      const allDatabases = config.connections.flatMap((connection) =>
        connection.databases.map((database) => ({
          connectionName: connection.name,
          type: resolveConnectionType(connection),
          host: connection.host,
          port: connection.port,
          environment: connection.environment ?? null,
          name: database.name,
          description: database.description,
        })),
      );
      return textResult(allDatabases);
    }

    if (name === "query") {
      const dbName = args?.dbName;
      const sql = args?.sql;
      const connectionName = args?.connectionName;
      const params = Array.isArray(args?.params) ? args.params : [];

      if (typeof dbName !== "string" || typeof sql !== "string") {
        throw new Error(
          "Missing required arguments: dbName and sql must be strings.",
        );
      }

      if (connectionName !== undefined && typeof connectionName !== "string") {
        throw new Error("connectionName must be a string when provided.");
      }

      const resolved = findDatabase(config, dbName, connectionName);

      if (!isReadOnlySelect(sql)) {
        throw new Error(
          "Only read-only SELECT, SHOW, DESCRIBE, DESC, or EXPLAIN queries are allowed.",
        );
      }

      const result = await executeQuery(
        resolved.connection,
        resolved.database.name,
        sql,
        params,
        timeoutMs,
        rowLimit,
      );
      return textResult(result);
    }

    throw new Error(`Unknown tool: ${name}`);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting db-query-mcp:", error);
  process.exit(1);
});
