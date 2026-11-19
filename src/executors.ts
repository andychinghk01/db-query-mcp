import mysql, { type RowDataPacket } from "mysql2/promise";
import pg from "pg";
import { getSecretStore, SecretMissing } from "./secrets.js";
import type { ConnectionConfig, QueryResult } from "./types.js";

type MysqlQueryOptions = {
  sql: string;
  values?: unknown[];
  timeout?: number;
  rowsAsArray?: boolean;
  namedPlaceholders?: boolean;
};

export function withRowLimit(
  sql: string,
  type: "mysql" | "postgresql",
  limit: number,
): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (/^\s*SELECT\b/i.test(trimmed)) {
    return `SELECT * FROM (${trimmed}) AS _dq_sub LIMIT ${limit}`;
  }
  return trimmed;
}

function rowsToResult(
  allRows: Record<string, unknown>[],
  rowLimit: number,
): QueryResult {
  const rows = allRows.slice(0, rowLimit);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export function sanitizeDriverError(error: unknown, secrets: string[]): Error {
  const redact = (value: string): string => secrets.reduce(
    (current, secret) => secret.length > 0 ? current.split(secret).join("[redacted]") : current,
    value,
  );
  const result = new Error(redact(error instanceof Error ? error.message : "Database driver request failed."));
  if (error instanceof Error && "code" in error) {
    const code = error.code;
    if (typeof code === "string" || typeof code === "number") {
      const redacted = redact(String(code));
      Object.defineProperty(result, "code", { value: redacted === String(code) ? code : redacted, enumerable: true });
    }
  }
  return result;
}

export async function resolvePassword(connection: ConnectionConfig): Promise<string> {
  const password = connection.password ?? await getSecretStore().get(connection.name);
  if (password === null) {
    throw new SecretMissing(connection.name);
  }
  return password;
}

export async function executeMysqlQuery(
  connection: ConnectionConfig,
  databaseName: string,
  sql: string,
  params: unknown[],
  timeoutMs: number,
  rowLimit: number,
): Promise<QueryResult> {
  const password = await resolvePassword(connection);
  try {
    const conn = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password,
      database: databaseName,
      connectTimeout: Math.min(timeoutMs, 10_000),
    });
    try {
      const queryOptions: MysqlQueryOptions = {
        sql: withRowLimit(sql, "mysql", rowLimit),
        values: params,
        timeout: timeoutMs,
        rowsAsArray: false,
        namedPlaceholders: false,
      };
      const [rows] = await conn.query<RowDataPacket[]>(queryOptions);
      return rowsToResult(rows as Record<string, unknown>[], rowLimit);
    } finally {
      await conn.end();
    }
  } catch (error) {
    throw sanitizeDriverError(error, [password]);
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
  const password = await resolvePassword(connection);
  try {
    const client = new pg.Client({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password,
      database: databaseName,
      connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
    });
    try {
      await client.connect();
      const result = await client.query(withRowLimit(sql, "postgresql", rowLimit), params);
      return rowsToResult(result.rows, rowLimit);
    } finally {
      await client.end();
    }
  } catch (error) {
    throw sanitizeDriverError(error, [password]);
  }
}
