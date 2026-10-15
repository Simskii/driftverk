import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { decodeDataFrame, encodeDataFrame, verifySignedToken, requestToken } from "./protocol.mjs";

test("round trips binary tunnel frames", () => {
  const decoded = decodeDataFrame(encodeDataFrame(42, Buffer.from("hello"), 0));
  assert.equal(decoded.streamId, 42);
  assert.equal(decoded.binary, false);
  assert.equal(decoded.channel, 0);
  assert.equal(decoded.data.toString(), "hello");
});

test("preserves the SSH stderr data channel", () => {
  const decoded = decodeDataFrame(encodeDataFrame(7, Buffer.from("failure"), 2));
  assert.equal(decoded.channel, 2);
  assert.equal(decoded.data.toString(), "failure");
});

test("verifies signed, unexpired grants", () => {
  const secret = "test-secret-with-at-least-32-characters";
  const payload = Buffer.from(JSON.stringify({ nodeId: "node-1", expiresAt: Date.now() + 10_000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  assert.equal(verifySignedToken(`${payload}.${signature}`, secret)?.nodeId, "node-1");
  assert.equal(verifySignedToken(`${payload}.${signature}x`, secret), null);
});


test("application query tokens do not override signed preview cookies", () => {
  const secret = "preview-test-secret";
  const sign = expiresAt => {
    const payload = Buffer.from(JSON.stringify({ nodeId: "node", expiresAt })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  const fresh = sign(Date.now() + 60_000);
  const expired = sign(Date.now() - 60_000);
  for (const appToken of ["app-session", "header.payload.signature"]) {
    const request = { url: `/socket?token=${appToken}&vsn=2`, headers: { cookie: `dv_preview=${fresh}` } };
    assert.equal(requestToken(request, secret), fresh);
    assert.equal(request.url, `/socket?token=${appToken}&vsn=2`);
  }
  assert.equal(requestToken({ url: `/?token=${fresh}`, headers: { cookie: `dv_preview=${expired}` } }, secret), fresh);
  assert.equal(requestToken({ url: `/?token=${fresh}`, headers: {} }, secret), fresh);
  assert.equal(verifySignedToken(requestToken({ url: "/?token=invalid", headers: {} }, secret), secret), null);
});
