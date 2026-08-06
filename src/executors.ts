import mysql, { type RowDataPacket } from "mysql2/promise";
import pg from "pg";
import type { ConnectionConfig, QueryResult } from "./types.js";

/** Per-query options for mysql2's connection.query(). */
interface MysqlQueryOptions {
  sql: string;
  values?: unknown[];
  timeout?: number;
  rowsAsArray?: boolean;
  namedPlaceholders?: boolean;
}

/**
 * Apply a row limit to a query without rewriting SELECT lists.
 *
 * MySQL: `LIMIT n` can be appended to most SELECT/SHOW/EXPLAIN statements.
 * Postgres: `FETCH FIRST n ROWS ONLY` works on SELECT; we fall back to
 * LIMIT for SHOW/DESCRIBE/EXPLAIN which are Postgres-extended via psql.
 * To keep it simple and correct for both engines, we wrap the user query
 * as a subselect when it is a SELECT — this also guarantees the limit
 * applies to the outer result regardless of an inner LIMIT the user wrote.
 */
function withRowLimit(sql: string, type: "mysql" | "postgresql", limit: number): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (type === "postgresql") {
    // FETCH FIRST works on SELECT; SHOW/DESCRIBE/EXPLAIN don't accept it,
    // so only wrap SELECTs. Postgres EXPLAIN returns rows too, but limiting
    // an EXPLAIN is meaningless — leave those unmodified.
    if (/^\s*SELECT\b/i.test(trimmed)) {
      return `SELECT * FROM (${trimmed}) AS _dq_sub LIMIT ${limit}`;
    }
    return trimmed;
  }
  // MySQL: append LIMIT. A trailing LIMIT from the user is overridden by the
  // guard's outer subselect wrapper below for SELECTs.
  if (/^\s*SELECT\b/i.test(trimmed)) {
    return `SELECT * FROM (${trimmed}) AS _dq_sub LIMIT ${limit}`;
  }
  // SHOW/DESCRIBE/EXPLAIN — append LIMIT (MySQL accepts it on SHOW/EXPLAIN).
  return `${trimmed} LIMIT ${limit}`;
}

function rowsToResult(
  rows: Record<string, unknown>[],
): QueryResult {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export async function executeMysqlQuery(
  connection: ConnectionConfig,
  databaseName: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<QueryResult> {
  const conn = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: databaseName,
    connectTimeout: Math.min(timeoutMs, 10_000),
  });
  try {
    const limitedSql = withRowLimit(sql, "mysql", rowLimit);
    const queryOptions: MysqlQueryOptions = {
      sql: limitedSql,
      values: params,
      timeout: timeoutMs,
      rowsAsArray: false,
      namedPlaceholders: false,
    };
    const [rows] = await conn.query<RowDataPacket[]>(queryOptions);
    return rowsToResult(rows as Record<string, unknown>[]);
  } finally {
    await conn.end();
  }
}

export async function executePostgresQuery(
  connection: ConnectionConfig,
  databaseName: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<QueryResult> {
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: databaseName,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  try {
    await client.connect();
    const limitedSql = withRowLimit(sql, "postgresql", rowLimit);
    const result = await client.query(limitedSql, params);
    return rowsToResult(result.rows);
  } finally {
    await client.end();
  }
}
