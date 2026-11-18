# db-query-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for running **read-only SQL queries** across multiple **MySQL** and **PostgreSQL** databases. Built with TypeScript and runs on [Bun](https://bun.sh/).

Give an AI assistant (Claude Desktop, Copilot, Cursor, Zed, or any MCP-compatible client) safe, read-only access to your databases — without pasting credentials into the chat.

## Features

- 🗄️ **MySQL & PostgreSQL** — mix both engines in one config
- 🔒 **Read-only by design** — only `SELECT`/`SHOW`/`DESCRIBE`/`DESC`/`EXPLAIN`; DML/DDL keywords rejected
- 🔐 **Credentials out of source** — connection config lives in `~/.config/db-query-mcp/config.json`, never in the repo
- ⏱️ **Safety guardrails** — automatic `LIMIT`, per-query timeout, parameterized queries
- 📦 **Installable** — `bunx` or global install; one binary, no source editing
- 🧩 **Single config, many databases** — each connection can expose multiple databases

## Requirements

- [Bun](https://bun.sh/)

## Install

### Run without installing (recommended for MCP clients)

```bash
bunx db-query-mcp
```

### Install globally

```bash
bun add -g db-query-mcp
```

Then run `db-query-mcp` directly.

### From source

```bash
git clone https://github.com/andychinghk01/db-query-mcp.git
cd db-query-mcp
bun install
bun start
```

## Configuration

db-query-mcp reads connections from a JSON config file.

**Path** (first match wins):

1. `DB_QUERY_MCP_CONFIG` env var (absolute path)
2. `~/.config/db-query-mcp/config.json`

### Create the config

```bash
mkdir -p ~/.config/db-query-mcp
```

Create `~/.config/db-query-mcp/config.json` with the schema below and edit it with your real credentials.

### Example

```json
{
  "queryTimeoutMs": 30000,
  "defaultRowLimit": 1000,
  "connections": [
    {
      "name": "stg-mysql",
      "description": "Read-only staging MySQL",
      "type": "mysql",
      "host": "mysql.example.com",
      "port": 3306,
      "username": "readonly-user",
      "password": "your-password",
      "databases": [
        { "name": "users", "description": "User accounts" },
        { "name": "billing", "description": "Billing and invoices" }
      ]
    },
    {
      "name": "prod-postgres",
      "description": "Read-only production PostgreSQL",
      "type": "postgresql",
      "host": "postgres.example.com",
      "port": 5432,
      "username": "readonly-user",
      "password": "your-password",
      "databases": [
        { "name": "analytics", "description": "Event analytics warehouse" }
      ]
    },
    {
      "name": "legacy-mysql",
      "description": "Legacy MySQL (type omitted, defaults to mysql)",
      "host": "legacy.example.com",
      "port": 3306,
      "username": "readonly-user",
      "password": "your-password",
      "databases": [
        { "name": "legacy_app", "description": "Legacy application DB" }
      ]
    }
  ]
}
```

### Schema

```jsonc
{
  "queryTimeoutMs": 30000,   // optional, default 30000
  "defaultRowLimit": 1000,   // optional, default 1000
  "connections": [
    {
      "name": "unique-connection-id",      // shown in list_db
      "description": "Human-readable note",
      "type": "mysql",                      // "mysql" | "postgresql"; defaults to "mysql"
      "host": "db.example.com",
      "port": 3306,
      "username": "readonly-user",
      "password": "your-password",
      "databases": [
        { "name": "actual_db_name", "description": "What this DB contains" }
      ]
    }
  ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `connections` | array | yes | One entry per server you connect to |
| `connections[].type` | `"mysql"` \| `"postgresql"` | no | Defaults to `"mysql"` |
| `connections[].databases` | array | yes | Each becomes a queryable target in `list_db` |
| `queryTimeoutMs` | number | no | Per-query timeout, default 30000 |
| `defaultRowLimit` | number | no | Max rows returned, default 1000 |

> 💡 **Use a dedicated read-only database user.** The server enforces read-only SQL, but defense in depth matters — grant only `SELECT` (and `SHOW`/`EXPLAIN` where needed) to the user in this config.

## MCP client configuration

Add the server to your MCP client config.

### Claude Desktop / Claude Code (`claude_desktop_config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "db-query-mcp": {
      "command": "bunx",
      "args": ["db-query-mcp"]
    }
  }
}
```

### Custom config path

```json
{
  "mcpServers": {
    "db-query-mcp": {
      "command": "bunx",
      "args": ["db-query-mcp"],
      "env": { "DB_QUERY_MCP_CONFIG": "/custom/path/config.json" }
    }
  }
}
```

## Tools

### `list_db`

Lists every configured database with its connection name, engine type, host, port, and description. No arguments.

### `query`

Executes a read-only query.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `dbName` | string | yes | Database name from `list_db` |
| `connectionName` | string | no | Connection name from `list_db`. Required when the same `dbName` exists on several connections |
| `sql` | string | yes | Read-only SQL statement |
| `params` | array | no | Positional parameters — `?` for MySQL, `$1, $2, ...` for PostgreSQL |

If the same database name is exposed by more than one connection (e.g. a staging and a prod `account_system`), a call with only `dbName` fails with an error listing the connections instead of guessing. Pass `connectionName` to choose one:

```json
{ "connectionName": "prod_account_system", "dbName": "account_system", "sql": "SELECT 1" }
```

`EXPLAIN`, `SHOW`, and `DESCRIBE` statements are sent as written (no `LIMIT` is appended, since the engines reject it); their result rows are still capped at `defaultRowLimit` after the query returns.

## Safety guardrails

- **Statement allowlist** — only `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN` may start a query.
- **Keyword denylist** — `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `REPLACE`, `MERGE`, `CALL`, `EXEC`, `GRANT`, `REVOKE`, `LOCK`, `UNLOCK`, `LOAD DATA` are rejected anywhere in the statement (after comment/quote normalization).
- **Row limit** — `SELECT`s are wrapped as subselects and capped at `defaultRowLimit` (default 1000).
- **Timeout** — queries abort after `queryTimeoutMs` (default 30s).
- **Parameterized queries** — use `?` (MySQL) or `$1` (Postgres) placeholders; values never interpolated into SQL.

These guardrails reduce risk but are not a substitute for least-privilege database permissions. Always pair this server with a read-only DB user.

## Development

```bash
bun install
bun dev     # watch mode
bun start   # run src/index.ts
```

No build step is required — Bun runs TypeScript directly.

## License

MIT © Andy Ching
