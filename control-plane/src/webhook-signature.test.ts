import assert from "node:assert/strict";
import { test } from "node:test";
import { signWebhook, verifyWebhookSignature } from "./webhook-signature.js";

test("signs a stable webhook payload", () => {
  const secret = `whsec_${Buffer.from("secret-key").toString("base64")}`;
  assert.equal(
    signWebhook(secret, "evt_123", 1_700_000_000, '{"type":"environment.running"}'),
    "v1,ENfx5u514MEs/qJy6el7hitppn70ZpiEOA6YR6DFNo8=",
  );
});

test("verifies matching signatures and rejects changed bodies", () => {
  const secret = `whsec_${Buffer.from("secret-key").toString("base64")}`;
  const signature = signWebhook(secret, "evt_123", 1_700_000_000, "body");
  assert.equal(verifyWebhookSignature(secret, signature, "evt_123", 1_700_000_000, "body"), true);
  assert.equal(verifyWebhookSignature(secret, signature, "evt_123", 1_700_000_000, "changed"), false);
});
