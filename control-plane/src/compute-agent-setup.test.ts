import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUserCode } from "./compute-agent-setup-code.js";

test("normalizes a pasted compute agent setup code", () => {
  assert.equal(normalizeUserCode(" abcd-2345 "), "ABCD-2345");
  assert.equal(normalizeUserCode("abcd 2345"), "ABCD-2345");
});

test("rejects malformed compute agent setup codes", () => {
  assert.equal(normalizeUserCode("short"), "");
  assert.equal(normalizeUserCode(null), "");
});
