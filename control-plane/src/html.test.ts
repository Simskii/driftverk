import assert from "node:assert/strict";
import test from "node:test";
import { authPage, document } from "./html.js";

test("auth pages use the expected Better Auth endpoints", () => {
  const signIn = authPage({ mode: "sign-in", nonce: "testnonce", allowSignUp: true });
  const signUp = authPage({ mode: "sign-up", nonce: "testnonce", allowSignUp: true });
  const reset = authPage({
    mode: "forgot-password",
    nonce: "testnonce",
    allowSignUp: true,
  });

  assert.match(signIn, /\/api\/auth\/sign-in\/email/);
  assert.match(signUp, /\/api\/auth\/sign-up\/email/);
  assert.match(reset, /\/api\/auth\/request-password-reset/);
  assert.match(signIn, /<script nonce="testnonce">/);
  assert.match(signIn, /rel="icon" href="\/favicon\.svg"/);
});

test("document escapes the page title", () => {
  const result = document({ title: '<script>alert("x")</script>', body: "ok" });
  assert.doesNotMatch(result, /<title><script>/);
  assert.match(result, /&lt;script&gt;/);
});
