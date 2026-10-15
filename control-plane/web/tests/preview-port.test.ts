import assert from "node:assert/strict";
import test from "node:test";
import { defaultPreviewPort } from "../src/preview-port.js";

test("configured preview ports work before telemetry arrives", () => {
  assert.equal(defaultPreviewPort(4321, []), 4321);
});
test("preview selects a conventional web listener instead of SSH or a database", () => {
  assert.equal(defaultPreviewPort(null, [{ port: 22 }, { port: 5432 }, { port: 5173 }]), 5173);
  assert.equal(defaultPreviewPort(null, [{ port: 5432 }]), null);
  assert.equal(defaultPreviewPort(null, []), null);
});
