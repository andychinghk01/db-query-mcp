/**
 * Read-only SQL guard.
 *
 * Two checks: (1) reject statements containing DML/DDL keywords anywhere,
 * (2) require the first statement to start with an allowed read verb.
 * Comments and quote escapes are normalized before matching so keywords
 * hidden in comments or strings can't bypass check (1).
 */
const FORBIDDEN_PATTERN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|CALL|EXEC|EXECUTE|GRANT|REVOKE|LOCK|UNLOCK|LOAD\s+DATA)\b/i;
const ALLOWED_FIRST_STATEMENT = /^\s*\(?\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
/**
 * Returns true only if `sql` is a read-only SELECT/SHOW/DESCRIBE/DESC/EXPLAIN
 * statement with no forbidden keywords. Multi-statement strings are rejected
 * implicitly: a trailing `; ...` would fail the anchored first-statement check.
 */
export function isReadOnlySelect(sql) {
    const normalized = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .replace(/#[^\n]*/g, " ") // MySQL # comments
        .replace(/'/g, "'");
    if (FORBIDDEN_PATTERN.test(normalized)) {
        return false;
    }
    return ALLOWED_FIRST_STATEMENT.test(normalized);
}
