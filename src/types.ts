/**
 * Type definitions for db-query-mcp configuration.
 *
 * Connection config lives in ~/.config/db-query-mcp/config.json
 * (see src/config.ts for the loader and precedence rules).
 */

export type DatabaseType = "mysql" | "postgresql";

export interface DatabaseConfig {
  /** Database name as it exists on the server. Used as the query target. */
  name: string;
  /** Human-readable description shown by the `list_db` tool. */
  description: string;
}

export interface ConnectionConfig {
  /** Short, unique identifier shown in list_db output. */
  name: string;
  /** Human-readable description of the connection. */
  description: string;
  /** Database engine. Defaults to "mysql" when omitted for backward compat. */
  type?: DatabaseType;
  host: string;
  port: number;
  username: string;
  password?: string;
  environment?: "dev" | "stg" | "prod";
  databases: DatabaseConfig[];
}

export interface ServerConfig {
  /** Registered database connections. */
  connections: ConnectionConfig[];
  /** Query timeout in milliseconds. Default: 30000. */
  queryTimeoutMs?: number;
  /** Maximum rows returned per query. Default: 1000. */
  defaultRowLimit?: number;
}

/** A connection resolved together with one of its databases. */
export interface ResolvedDatabase {
  connection: ConnectionConfig;
  database: DatabaseConfig;
}

/** Shape returned by both executors. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}
