import assert from "node:assert/strict";
import test from "node:test";
import { mergeImportedVariables, parseEnvImport } from "../src/env-import";

test("imports common .env syntax without evaluating data", () => {
  const result = parseEnvImport('\uFEFF# comment\r\nexport APP_MODE=development\r\nURL="https://example.test/#anchor" # note\nEMPTY=\nTOKEN=abc=def\nLITERAL=${TOKEN}\nCOMMAND=$(whoami)');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.variables, [
    { name: "APP_MODE", value: "development" },
    { name: "URL", value: "https://example.test/#anchor" },
    { name: "EMPTY", value: "" },
    { name: "TOKEN", value: "abc=def" },
    { name: "LITERAL", value: "${TOKEN}" },
    { name: "COMMAND", value: "$(whoami)" },
  ]);
});

test("supports multiline and escaped double-quoted values while preserving single quotes literally", () => {
  const result = parseEnvImport('MULTI="first\nsecond"\nESCAPED="a\\n\\"b\\"\\\\end"\nSINGLE=\'a\\nb\'\nINLINE=value # comment');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.variables, [
    { name: "MULTI", value: "first\nsecond" },
    { name: "ESCAPED", value: 'a\n"b"\\end' },
    { name: "SINGLE", value: "a\\nb" },
    { name: "INLINE", value: "value" },
  ]);
});

test("reports invalid lines and duplicates without exposing supplied values", () => {
  const result = parseEnvImport('TOKEN=private-one\nTOKEN=private-two\nbad-name=private-three\nNO_EQUALS private-four\nBAD="private-five" junk');
  assert.equal(result.errors.length, 4);
  assert.equal(result.variables.length, 1);
  assert.equal(result.errors.join(" ").includes("private"), false);
  assert.match(result.errors[0], /Line 2.*more than once/);
});

test("rejects unclosed quoted values and oversized values/files", () => {
  assert.match(parseEnvImport('KEY="unfinished').errors[0], /unclosed/);
  assert.match(parseEnvImport(`KEY=${"x".repeat(32769)}`).errors[0], /32,768/);
  assert.match(parseEnvImport("x".repeat(1_048_577)).errors[0], /1 MB/);
});

test("merging replaces only explicitly imported names and preserves unrelated edits", () => {
  assert.deepEqual(mergeImportedVariables([
    { name: "KEEP", value: "original" }, { name: "REPLACE", value: "old" }, { name: "", value: "" },
  ], [{ name: "REPLACE", value: "new" }, { name: "NEW", value: "" }]), [
    { name: "KEEP", value: "original" }, { name: "REPLACE", value: "new" }, { name: "NEW", value: "" },
  ]);
});
