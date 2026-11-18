import type { ResolvedDatabase, ServerConfig } from "./types.js";

/**
 * Resolve a database name (optionally scoped to a connection) to its
 * connection + database. Throws when the target is missing or ambiguous;
 * never silently picks the first of several matches.
 */
export function findDatabase(
  config: ServerConfig,
  name: string,
  connectionName?: string,
): ResolvedDatabase {
  if (connectionName !== undefined) {
    const connection = config.connections.find((c) => c.name === connectionName);
    if (!connection) {
      const valid = config.connections.map((c) => c.name).join(", ");
      throw new Error(
        `Connection "${connectionName}" not found. Valid connection names: ${valid}.`,
      );
    }
    const database = connection.databases.find((d) => d.name === name);
    if (!database) {
      const available = connection.databases.map((d) => d.name).join(", ");
      throw new Error(
        `Database "${name}" not found on connection "${connectionName}". ` +
          `Databases on this connection: ${available}.`,
      );
    }
    return { connection, database };
  }

  const matches: ResolvedDatabase[] = [];
  for (const connection of config.connections) {
    const database = connection.databases.find((d) => d.name === name);
    if (database) {
      matches.push({ connection, database });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `Database "${name}" not found. Use list_db to see available databases.`,
    );
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m.connection.name).join(", ");
    throw new Error(
      `Database "${name}" exists on multiple connections: ${names}. ` +
        `Pass connectionName to choose one.`,
    );
  }
  return matches[0];
}
