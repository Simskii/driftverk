import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvironmentVariable } from "./environment-variables.js";

test("parses a valid environment variable", () => {
  assert.deepEqual(parseEnvironmentVariable({ name: " DATABASE_URL ", value: "postgres://db" }), {
    name: "DATABASE_URL",
    value: "postgres://db",
  });
});

test("rejects invalid names and oversized values", () => {
  assert.equal(parseEnvironmentVariable({ name: "1INVALID", value: "value" }), null);
  assert.equal(parseEnvironmentVariable({ name: "WITH-DASH", value: "value" }), null);
  assert.equal(parseEnvironmentVariable({ name: "VALID", value: "x".repeat(32769) }), null);
});
