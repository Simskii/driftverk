import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptWithKeyring, encryptWithKeyring, parseSecretKeyring } from "./secret-codec.js";

const firstKey = Buffer.alloc(32, 1).toString("base64");
const secondKey = Buffer.alloc(32, 2).toString("base64");

test("encrypts with the active key and decrypts after rotation", () => {
  const initial = parseSecretKeyring(`2026-09=${firstKey}`);
  const encrypted = encryptWithKeyring("top secret", initial, "environment:dev_1:TOKEN");
  assert.match(encrypted.encryptedValue, /^dvenc:v2:2026-09:/);

  const rotated = parseSecretKeyring(`2026-10=${secondKey},2026-09=${firstKey}`);
  assert.equal(decryptWithKeyring(encrypted.encryptedValue, encrypted.iv, rotated, "environment:dev_1:TOKEN"), "top secret");
  assert.throws(() => decryptWithKeyring(encrypted.encryptedValue, encrypted.iv, rotated, "environment:dev_2:TOKEN"));
});

test("refuses malformed, duplicate, and incorrectly sized keys", () => {
  assert.throws(() => parseSecretKeyring("missing-separator"));
  assert.throws(() => parseSecretKeyring(`same=${firstKey},same=${secondKey}`));
  assert.throws(() => parseSecretKeyring(`short=${Buffer.alloc(16).toString("base64")}`));
});

test("decrypts values created by the legacy Better Auth derived key", () => {
  const legacyKey = createHash("sha256").update("legacy-auth-secret").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  const payload = Buffer.concat([cipher.update("legacy value", "utf8"), cipher.final(), cipher.getAuthTag()]);
  const keyring = parseSecretKeyring(`current=${firstKey}`);
  assert.equal(
    decryptWithKeyring(payload.toString("base64"), iv.toString("base64"), keyring, "legacy", legacyKey),
    "legacy value",
  );
});

test("fails closed when the encrypted value references an unavailable key", () => {
  const encrypted = encryptWithKeyring("value", parseSecretKeyring(`old=${firstKey}`), "test:value");
  assert.throws(
    () => decryptWithKeyring(encrypted.encryptedValue, encrypted.iv, parseSecretKeyring(`new=${secondKey}`), "test:value"),
    /unavailable: old/,
  );
});
