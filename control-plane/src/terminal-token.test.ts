import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalToken, verifyTerminalToken } from "./terminal-token.js";

test("verifies a current terminal ticket", () => {
  const grant = { sandboxId: "sandbox-1", nodeId: "compute-1", nonce: "nonce", expiresAt: Date.now() + 1000 };
  assert.deepEqual(verifyTerminalToken(createTerminalToken(grant, "secret"), "secret"), grant);
});

test("rejects tampered and expired terminal tickets", () => {
  const expired = createTerminalToken({ sandboxId: "sandbox-1", nodeId: "compute-1", nonce: "nonce", expiresAt: Date.now() - 1 }, "secret");
  assert.equal(verifyTerminalToken(expired, "secret"), null);
  const current = createTerminalToken({ sandboxId: "sandbox-1", nodeId: "compute-1", nonce: "nonce", expiresAt: Date.now() + 1000 }, "secret");
  assert.equal(verifyTerminalToken(`${current}x`, "secret"), null);
  assert.equal(verifyTerminalToken(`${current}.extra`, "secret"), null);
});
