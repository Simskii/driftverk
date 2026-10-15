import assert from "node:assert/strict";
import test from "node:test";
import { parsePublicKey } from "./ssh-public-key.js";

test("normalizes an OpenSSH public key and ignores its comment", () => {
  const encoded = Buffer.alloc(32, 7).toString("base64");
  const parsed = parsePublicKey(`ssh-ed25519 ${encoded} operator@example.com`);
  assert.equal(parsed?.publicKey, `ssh-ed25519 ${encoded}`);
  assert.match(parsed?.fingerprint ?? "", /^SHA256:[A-Za-z0-9+/]+$/);
});

test("rejects unsupported and malformed public keys", () => {
  assert.equal(parsePublicKey("ssh-dss AAAAB3NzaC1kc3MAAACB"), null);
  assert.equal(parsePublicKey("ssh-ed25519 not-base64"), null);
});
