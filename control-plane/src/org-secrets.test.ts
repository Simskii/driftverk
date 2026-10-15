import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";

const { db } = await import("./db.js");
const { organizationSecrets, resolveOrganizationSecrets } = await import("./org-secrets.js");
const { encryptSecret, decryptSecret, secretContext } = await import("./secrets.js");
const { parseTemplate, parseOrganizationSecretNames } = await import("./development-config.js");
const { createEnvironmentForActor } = await import("./environment-service.js");

test("organization secret management is scoped, admin-only and never returns values", async t => {
  let role = "admin";
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  t.mock.method(db, "query", async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args });
    if (sql.includes("FROM memberships")) return { rows: [{ organization_id: "org", role }], rowCount: 1 };
    return { rows: [{ name: "PACKAGE_TOKEN", updated_at: "now" }], rowCount: 1 };
  });
  const context = (method: string, body: unknown = { name: "PACKAGE_TOKEN", value: "test-package-value" }) => ({
    req: { method, param: () => "PACKAGE_TOKEN", json: async () => body },
    get: () => ({ user: { id: "user" }, session: { activeOrganizationId: "org" } }),
    json: (body: unknown, status = 200) => ({ body, status }),
  }) as unknown as Parameters<typeof organizationSecrets>[0];
  const saved = await organizationSecrets(context("POST"));
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved).includes("test-package-value"));
  const insert = queries.find(q => q.sql.includes("INSERT INTO organization_secrets"))!;
  assert.equal(insert.args[0], "org");
  assert.equal(decryptSecret(insert.args[2] as string, insert.args[3] as string, secretContext.organization("org", "PACKAGE_TOKEN")), "test-package-value");
  assert.throws(() => decryptSecret(insert.args[2] as string, insert.args[3] as string, secretContext.organization("other", "PACKAGE_TOKEN")));
  role = "member";
  assert.equal((await organizationSecrets(context("POST"))).status, 403);
  assert.equal((await organizationSecrets(context("DELETE"))).status, 403);
  assert.equal((await organizationSecrets(context("GET"))).status, 200);
  role = "admin";
  assert.equal((await organizationSecrets(context("POST", { name: "BAD-NAME", value: "x" }))).status, 400);
  assert.equal((await organizationSecrets(context("POST", { name: "TOKEN", value: "" }))).status, 400);
  assert.equal((await organizationSecrets(context("DELETE"))).status, 200);
});

test("explicit references reject invalid names, missing secrets and direct variable collisions", async () => {
  for (const value of [null, "TOKEN", ["A", "A"], ["A-B"], [1], Array.from({ length: 26 }, (_, i) => `V${i}`)]) assert.throws(() => parseOrganizationSecretNames(value));
  const template = parseTemplate({ name: "App", configuration: { image: "node", organization_secret_names: ["TOKEN"], environment_variables: [{ name: "TOKEN", value: "never-store" }] } });
  assert.deepEqual(template.configuration.organization_secret_names, ["TOKEN"]);
  assert.ok(!JSON.stringify(template).includes("never-store"));
  const empty = { query: async () => ({ rows: [] }) } as unknown as Pick<PoolClient, "query">;
  await assert.rejects(resolveOrganizationSecrets("org", ["TOKEN"], [], empty), /Required organization secrets are missing/);
  await assert.rejects(resolveOrganizationSecrets("org", ["TOKEN"], [{ name: "TOKEN", value: "override" }], empty), /conflicts/);
});

test("trusted creation copies and re-encrypts selected secrets; untrusted actors cannot bind them", async () => {
  const encrypted = encryptSecret("fixture-value", secretContext.organization("org", "TOKEN"));
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (sql.includes("FROM organization_secrets")) {
      assert.deepEqual(args, ["org", ["TOKEN"]]);
      return { rows: [{ name: "TOKEN", encrypted_value: encrypted.encryptedValue, iv: encrypted.iv }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  } } as unknown as PoolClient;
  const actor = { organizationId: "org", organizationName: "Org", organizationSlug: "org", actorUserId: "user", automationIdPrefix: null };
  const input = { image: `ghcr.io/example/app@sha256:${"a".repeat(64)}`, code_trust: "trusted", organization_secret_names: ["TOKEN"] };
  await assert.rejects(createEnvironmentForActor(actor, { ...input, code_trust: "untrusted" }, client), /require a trusted environment/);
  await assert.rejects(createEnvironmentForActor({ ...actor, automationIdPrefix: "github:1:pr:" }, input, client), /unrestricted organization actor/);
  const created = await createEnvironmentForActor(actor, input, client);
  const variable = calls.find(c => c.sql.includes("INSERT INTO sandbox_environment_variables"))!;
  assert.equal(decryptSecret(variable.args[2] as string, variable.args[3] as string, secretContext.environment("org", variable.args[0] as string, "TOKEN")), "fixture-value");
  assert.ok(calls.some(c => c.sql.includes("organization_secret_names = $2") && JSON.stringify(c.args[1]) === '["TOKEN"]'));
  assert.ok(!JSON.stringify(created).includes("fixture-value"));
});


test("blueprint updates validate organization references, enforce admin access and never persist values", async t => {
  const { environmentTemplates } = await import("./environment-templates.js");
  let role = "admin", exists = true;
  const updates: unknown[][] = [];
  t.mock.method(db, "query", async (sql: string, args: unknown[] = []) => {
    if (sql.includes("FROM memberships")) return { rows: [{ organization_id: "org", role }], rowCount: 1 };
    if (sql.includes("FROM organization_secrets")) { assert.equal(args[0], "org"); return { rows: exists ? [{ name: "TOKEN" }] : [], rowCount: exists ? 1 : 0 }; }
    if (sql.startsWith("UPDATE environment_templates")) { updates.push(args); return { rows: [{ id: "template" }], rowCount: 1 }; }
    throw new Error("Unexpected query");
  });
  const c = { get: () => ({ user: { id: "user" }, session: {} }), req: { method: "PUT", param: () => "template", json: async () => ({ name: "Example project", configuration: { image: "node", organization_secret_names: ["TOKEN"], environment_variables: [{ name: "TOKEN", value: "private-fixture" }] } }) }, json: (body: unknown, status = 200) => ({ body, status }) } as unknown as Parameters<typeof environmentTemplates>[0];
  assert.equal((await environmentTemplates(c)).status, 200);
  assert.equal(updates[0]?.[3], "org");
  assert.deepEqual(JSON.parse(updates[0]?.[1] as string).organization_secret_names, ["TOKEN"]);
  assert.ok(!JSON.stringify(updates).includes("private-fixture"));
  exists = false;
  assert.equal((await environmentTemplates(c)).status, 400);
  role = "member";
  assert.equal((await environmentTemplates(c)).status, 403);
  assert.equal(updates.length, 1);
});


test("organization secret routes include session and mutation origin middleware", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./app.ts", import.meta.url), "utf8");
  for (const method of ["get", "post", "delete"]) {
    const route = source.split("\n").find(line => line.startsWith(`app.${method}("/api/organization-secrets`));
    assert.ok(route?.includes(", requireSession,"), `${method} must authenticate before accessing organization secrets`);
    if (method !== "get") assert.ok(route?.includes(", requireTrustedOrigin,"), `${method} must check the mutation origin`);
  }
});
