import assert from "node:assert/strict";
import test from "node:test";
import { parseSshTarget } from "./ssh-target.js";

test("parses a workspace-scoped SSH target", () => {
  assert.deepEqual(parseSshTarget("acme-12ab34cd.api"), {
    organizationSlug: "acme-12ab34cd",
    environmentName: "api",
  });
});
test("normalizes case and surrounding whitespace", () => {
  assert.deepEqual(parseSshTarget("  ACME.PRODUCTION  "), {
    organizationSlug: "acme",
    environmentName: "production",
  });
});

test("accepts an environment name without an organization", () => {
  assert.deepEqual(parseSshTarget("  PRODUCTION  "), {
    organizationSlug: null,
    environmentName: "production",
  });
});

test("rejects malformed targets", () => {
  assert.equal(parseSshTarget("acme.api.extra"), null);
  assert.equal(parseSshTarget("acme_api.production"), null);
});
