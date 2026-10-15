import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createPreviewToken, verifyPreviewToken } from "./preview-token.js";

const secret = "test-preview-secret-with-at-least-32-characters";

test("signs and verifies a scoped preview grant", () => {
  const grant = { sandboxId: "dev_test", nodeId: "compute-1", port: 3000, expiresAt: Date.now() + 60_000 };
  assert.deepEqual(verifyPreviewToken(createPreviewToken(grant, secret), secret), grant);
});

test("rejects tampered and expired preview grants", () => {
  const valid = createPreviewToken({ sandboxId: "dev_test", nodeId: "compute-1", port: 3000, expiresAt: Date.now() + 60_000 }, secret);
  assert.equal(verifyPreviewToken(`${valid}x`, secret), null);
  assert.equal(verifyPreviewToken(`${valid}.extra`, secret), null);
  assert.equal(verifyPreviewToken(createPreviewToken({ sandboxId: "dev_test", nodeId: "compute-1", port: 3000, expiresAt: Date.now() - 1 }, secret), secret), null);
  const missingNodePayload = Buffer.from(JSON.stringify({ sandboxId: "dev_test", port: 3000, expiresAt: Date.now() + 60_000 })).toString("base64url");
  const missingNodeSignature = createHmac("sha256", secret).update(missingNodePayload).digest("base64url");
  assert.equal(verifyPreviewToken(`${missingNodePayload}.${missingNodeSignature}`, secret), null);
});
