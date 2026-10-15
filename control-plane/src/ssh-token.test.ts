import assert from "node:assert/strict";
import test from "node:test";
import { createSshToken, verifySshToken } from "./ssh-token.js";

const secret = "test-ssh-secret-with-at-least-32-characters";

test("round trips a node-bound SSH grant", () => {
  const token = createSshToken({ sandboxId: "env-1", nodeId: "node-1", nonce: "nonce-1", expiresAt: Date.now() + 10_000 }, secret);
  assert.deepEqual(verifySshToken(token, secret), {
    sandboxId: "env-1",
    nodeId: "node-1",
    nonce: "nonce-1",
    expiresAt: verifySshToken(token, secret)?.expiresAt,
  });
});

test("rejects expired and modified SSH grants", () => {
  const expired = createSshToken({ sandboxId: "env-1", nodeId: "node-1", nonce: "nonce-1", expiresAt: Date.now() - 1 }, secret);
  assert.equal(verifySshToken(expired, secret), null);
  assert.equal(verifySshToken(`${expired}x`, secret), null);
});
