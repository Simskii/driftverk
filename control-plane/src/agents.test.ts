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
const { agents, resolveAgentSetup } = await import("./agents.js");
const { decryptSecret, encryptSecret, secretContext } = await import("./secrets.js");
const { parseTemplate } = await import("./development-config.js");

function context(method: string, body: unknown = {}, id = "codex") {
  return { req: { method, json: async () => body, param: () => id }, get: () => ({ user: { id: "user" }, session: { activeOrganizationId: "org-a" } }), json: (body: unknown, status = 200) => ({ body, status }) } as unknown as Parameters<typeof agents>[0];
}

test("subscription setup never reads organization credentials and still requires trusted access", async () => {
  const client = { query: async () => { throw new Error("Must not read credentials"); } } as unknown as Pick<PoolClient, "query">;
  const setup = await resolveAgentSetup("org-a", "claude", true, [], client, "subscription");
  assert.deepEqual(setup, { configuration: { id: "claude", model: null, auth_method: "subscription" }, secretNames: [] });
  await assert.rejects(resolveAgentSetup("org-a", "codex", false, [], client, "subscription"), /trusted/);
  await assert.rejects(resolveAgentSetup("org-a", "codex", true, ["OPENAI_API_KEY"], client, "subscription"), /Remove/);
  await assert.rejects(resolveAgentSetup("org-a", "codex", true, [], client, "other"), /authentication/);
});

test("agent configuration is admin-only and never returns saved credentials", async t => {
  let role = "member";
  t.mock.method(db, "query", async (sql: string, args: unknown[]) => {
    if (sql.includes("FROM memberships")) return { rows: [{ organization_id: "org-a", role }], rowCount: 1 };
    if (sql.includes("FROM user_agent_connections")) { assert.equal(args[0], "user"); return { rows: [] }; }
    assert.equal(args[0], "org-a");
    if (sql.includes("FROM organization_agents")) return { rows: [{ agent_id: "codex", model: "model-1", is_default: true }] };
    return { rows: [{ name: "OPENAI_API_KEY" }], rowCount: 1 };
  });
  for (const method of ["PUT", "POST", "DELETE"]) assert.equal((await agents(context(method))).status, 403);
  role = "admin";
  const result = await agents(context("GET")) as unknown as { body: { agents: unknown[] } };
  assert.deepEqual(result.body.agents[0], { id: "codex", name: "Codex", model: "model-1", connected: true, api_key_is_default: true, is_default: true, subscription_connected: false, subscription_model: null, default_auth_method: "api_key" });
});

test("saving encrypts keys, serializes defaults, and scopes every mutation to the organization", async t => {
  const calls: { sql: string; args: unknown[] }[] = [];
  const query = async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    return { rows: [{ organization_id: "org-a", role: "admin" }], rowCount: 1 };
  };
  t.mock.method(db, "query", query);
  t.mock.method(db, "connect", async () => ({ query, release() {} }));
  const result = await agents(context("PUT", { api_key: "fixture-not-a-provider-key", model: "model-1", is_default: true }));
  assert.equal(result.status, 200);
  const stored = calls.find(call => call.sql.includes("INSERT INTO organization_secrets"))!;
  assert.equal(stored.args[0], "org-a");
  assert.equal(decryptSecret(stored.args[2] as string, stored.args[3] as string, secretContext.organization("org-a", "OPENAI_API_KEY")), "fixture-not-a-provider-key");
  assert.ok(!JSON.stringify(calls).includes("fixture-not-a-provider-key"));
  const lock = calls.findIndex(call => call.sql.includes("FOR UPDATE"));
  const clearDefault = calls.findIndex(call => call.sql.startsWith("UPDATE organization_agents"));
  assert.ok(lock >= 0 && clearDefault > lock);
  assert.deepEqual(calls[clearDefault]!.args, ["org-a"]);
  assert.equal((await agents(context("PUT", { model: "$(echo bad)", api_key: "fixture" }))).status, 400);
  assert.equal((await agents(context("PUT", { api_key: "key\nheader" }))).status, 400);
});

test("agent selection is explicit, trusted, scoped and resolves only its required key", async () => {
  const untouched = { query: async () => { throw new Error("Unexpected query"); } } as unknown as PoolClient;
  assert.deepEqual(await resolveAgentSetup("org-a", null, false, [], untouched), { configuration: null, secretNames: [] });
  await assert.rejects(resolveAgentSetup("org-a", "codex", false, [], untouched), /trusted environment/);
  await assert.rejects(resolveAgentSetup("org-a", "other", true, [], untouched), /Choose/);
  const client = { query: async (_sql: string, args: unknown[]) => {
    assert.deepEqual(args, ["org-a", "OPENAI_API_KEY", "codex"]);
    return { rows: [{ model: "model-1" }], rowCount: 1 };
  } } as unknown as PoolClient;
  assert.deepEqual(await resolveAgentSetup("org-a", "codex", true, ["PACKAGE_TOKEN", "OPENAI_API_KEY"], client), {
    configuration: { id: "codex", model: "model-1" }, secretNames: ["PACKAGE_TOKEN", "OPENAI_API_KEY"],
  });
  const missing = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
  await assert.rejects(resolveAgentSetup("org-b", "codex", true, [], missing), /Connect Codex/);
});

test("connection checks use fixed provider URLs, redact failures and do not run inference", async t => {
  const secret = encryptSecret("fixture-test-key", secretContext.organization("org-a", "OPENAI_API_KEY"));
  t.mock.method(db, "query", async (sql: string) => sql.includes("FROM memberships") ? { rows: [{ organization_id: "org-a", role: "admin" }], rowCount: 1 } : { rows: [{ encrypted_value: secret.encryptedValue, iv: secret.iv }], rowCount: 1 });
  let rejected = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    if (rejected) throw new Error("fixture-test-key must not escape");
    return new Response("{}", { status: 200 });
  });
  assert.equal((await agents(context("POST"))).status, 200);
  rejected = true;
  const response = await agents(context("POST"));
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response).includes("fixture-test-key"));
});

test("blueprints store the agent selection but never a submitted credential or copied model", () => {
  const result = parseTemplate({ name: "Agent project", configuration: { image: "node:24", agent_id: "codex", api_key: "private-fixture", agent_configuration: { id: "codex", model: "old-model" } } });
  assert.equal(result.configuration.agent_id, "codex");
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
  assert.ok(!JSON.stringify(result).includes("old-model"));
});
