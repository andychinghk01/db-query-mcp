import { expect, test } from "bun:test";
import { sanitizeDriverError } from "../executors.js";
import { SecretMissing } from "../secrets.js";

test("sanitizeDriverError redacts every secret and preserves driver code", () => {
  const error = Object.assign(new Error("Access denied password=s3cr3t and s3cr3t"), { code: "ER_ACCESS_DENIED_ERROR" });
  const result = sanitizeDriverError(error, ["s3cr3t"]);
  expect(result.message).toBe("Access denied password=[redacted] and [redacted]");
  expect(result).toHaveProperty("code", "ER_ACCESS_DENIED_ERROR");
});

test("sanitizeDriverError preserves useful SQL diagnostics", () => {
  expect(sanitizeDriverError(new Error("Unknown column 'foo'"), ["secret"]).message).toBe("Unknown column 'foo'");
  expect(sanitizeDriverError("bad", []).message).toBe("Database driver request failed.");
});

test("SecretMissing remains a typed error", () => {
  const error = new SecretMissing("demo");
  expect(error).toBeInstanceOf(SecretMissing);
  expect(error.message).toContain("set-password");
});
