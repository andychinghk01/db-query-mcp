import { describe, expect, test } from "bun:test";
import { withRowLimit } from "../executors.js";
import { findDatabase } from "../resolve.js";
import type { ConnectionConfig, ServerConfig } from "../types.js";

function conn(name: string, host: string, dbs: string[]): ConnectionConfig {
  return {
    name,
    description: name,
    host,
    port: 3306,
    username: "u",
    password: "p",
    databases: dbs.map((d) => ({ name: d, description: d })),
  };
}

const config: ServerConfig = {
  connections: [
    conn("stg_account_system", "stg.fake.invalid", ["account_system"]),
    conn("prod_account_system", "prod.fake.invalid", ["account_system"]),
    conn("other", "other.fake.invalid", ["only_here"]),
  ],
};

describe("findDatabase", () => {
  test("unique dbName resolves", () => {
    const r = findDatabase(config, "only_here");
    expect(r.connection.name).toBe("other");
    expect(r.database.name).toBe("only_here");
  });

  test("duplicate dbName without connectionName throws naming both", () => {
    expect(() => findDatabase(config, "account_system")).toThrow(
      /multiple connections: stg_account_system, prod_account_system/,
    );
  });

  test("connectionName selects prod, not staging", () => {
    const prod = findDatabase(config, "account_system", "prod_account_system");
    const stg = findDatabase(config, "account_system", "stg_account_system");
    expect(prod.connection.host).toBe("prod.fake.invalid");
    expect(stg.connection.host).toBe("stg.fake.invalid");
    expect(prod.connection.host).not.toBe(stg.connection.host);
  });

  test("unknown connectionName throws listing valid names", () => {
    expect(() => findDatabase(config, "account_system", "nope")).toThrow(
      /Valid connection names: stg_account_system, prod_account_system, other/,
    );
  });

  test("connection lacking the db throws and lists its databases", () => {
    expect(() => findDatabase(config, "account_system", "other")).toThrow(
      /not found on connection "other".*only_here/,
    );
  });

  test("unknown dbName throws not found", () => {
    expect(() => findDatabase(config, "missing")).toThrow(/not found/);
  });
});

describe("withRowLimit (mysql)", () => {
  test("SELECT is wrapped with LIMIT and trailing semicolon stripped", () => {
    expect(withRowLimit("SELECT 1;", "mysql", 50)).toBe(
      "SELECT * FROM (SELECT 1) AS _dq_sub LIMIT 50",
    );
  });

  test.each([
    "EXPLAIN SELECT * FROM t",
    "EXPLAIN ANALYZE SELECT * FROM t",
    "SHOW INDEX FROM t",
    "DESCRIBE t",
    "DESC t",
  ])("%s is returned unchanged", (sql) => {
    expect(withRowLimit(`${sql};`, "mysql", 50)).toBe(sql);
  });
});
