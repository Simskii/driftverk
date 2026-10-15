import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("agent defaults, creation, credential copies and terminal grants remain tenant-bound", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const schema = `agents_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const connection = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  connection.searchParams.set("options", `-csearch_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: connection.href, BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "test-better-auth-secret-000000000",
    SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", PREVIEW_TOKEN_SECRET: "test-preview-secret-0000000000000",
    TERMINAL_TOKEN_SECRET: "test-terminal-secret-000000000000", SSH_TOKEN_SECRET: "test-ssh-secret-000000000000000000",
    COMPUTE_AGENT_TOKEN: "test-compute-secret-0000000000000", MANAGED_COMPUTE_NODE_ID: "compute-1",
  });
  const { db } = await import("./db.js");
  const { migrate } = await import("./migrate.js");
  const { agents } = await import("./agents.js");
  const { createEnvironment } = await import("./workspace.js");
  const { createEnvironmentForActor } = await import("./environment-service.js");
  const { requireEnvironmentAccess } = await import("./environment-access.js");
  const { createTerminalTicket } = await import("./terminal.js");
  const { registerComputeRoutes } = await import("./compute.js");
  const { decryptSecret, secretContext } = await import("./secrets.js");
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await migrate();
    await db.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('admin','Admin','admin@agents.test',true),('member','Member','member@agents.test',true),('other','Other','other@agents.test',true);
      INSERT INTO organizations(id,name,slug) VALUES ('org','Agents QA','agents-qa'),('other-org','Other','other-agents');
      INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('ma','org','admin','admin'),('mm','org','member','member'),('mo','other-org','other','admin');
      UPDATE billing_accounts SET complimentary=true;`);
    let userId = "admin", organizationId = "org";
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("authSession", { user: { id: userId }, session: { activeOrganizationId: organizationId } } as never); await next(); });
    app.get("/agents", agents); app.put("/agents/:id", agents); app.delete("/agents/:id", agents);
    app.post("/environments", c => createEnvironment(c, c.get("authSession")));
    app.use("/environments/:id/*", requireEnvironmentAccess);
    app.post("/environments/:id/ticket", c => createTerminalTicket(c, c.get("authSession")));
    const request = (path: string, method: string, body: object = {}) => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const id of ["codex", "claude"]) assert.equal((await request(`/agents/${id}`, "PUT", { api_key: `fixture-${id}`, model: "model-1", is_default: true })).status, 200);
    assert.deepEqual((await db.query("SELECT agent_id FROM organization_agents WHERE is_default")).rows.map(row => row.agent_id), ["claude"]);
    const input = { image: "test:1", agent_id: "codex", workspace_path: "/workspaces/project" };
    const created = await request("/environments", "POST", input);
    assert.equal(created.status, 202, await created.clone().text());
    const { id } = await created.json();
    const stored = (await db.query("SELECT * FROM sandboxes WHERE id=$1", [id])).rows[0];
    assert.deepEqual(stored.agent_configuration, { id: "codex", model: "model-1" });
    assert.deepEqual(stored.organization_secret_names, [], "auto-added agent key must not become a manual blueprint secret");
    assert.equal(stored.has_ever_received_environment_secrets, true);
    const variable = (await db.query("SELECT * FROM sandbox_environment_variables WHERE sandbox_id=$1", [id])).rows[0];
    assert.equal(decryptSecret(variable.encrypted_value, variable.iv, secretContext.environment("org", id, "OPENAI_API_KEY")), "fixture-codex");
    assert.equal((await request("/environments", "POST", { ...input, environment_variables: [{ name: "OPENAI_API_KEY", value: "collision" }] })).status, 400);
    const none = await (await request("/environments", "POST", { image: "test:1", agent_id: null })).json();
    assert.equal((await db.query("SELECT 1 FROM sandbox_environment_variables WHERE sandbox_id=$1", [none.id])).rowCount, 0);
    const actor = { organizationId: "org", organizationName: "Agents QA", organizationSlug: "agents-qa", actorUserId: "admin", automationIdPrefix: null };
    await db.query("INSERT INTO user_agent_connections(id,user_id,agent_id,encrypted_value,iv) VALUES ('connection-admin','admin','codex','fixture','fixture')");
    const subscription = await (await request("/environments", "POST", { image: "test:1", agent_id: "codex", agent_auth_method: "subscription" })).json();
    assert.deepEqual((await db.query("SELECT agent_configuration FROM sandboxes WHERE id=$1", [subscription.id])).rows[0].agent_configuration, { id: "codex", model: null, auth_method: "subscription", connection_id: "connection-admin" });
    assert.equal((await db.query("SELECT 1 FROM sandbox_environment_variables WHERE sandbox_id=$1", [subscription.id])).rowCount, 0);
    const subscriptionApi = await createEnvironmentForActor(actor, { image: `test@sha256:${"a".repeat(64)}`, code_trust: "trusted", agent_id: "claude", agent_auth_method: "subscription" });
    assert.equal((await db.query("SELECT agent_configuration->>'auth_method' AS method FROM sandboxes WHERE id=$1", [subscriptionApi.environment_id])).rows[0].method, "subscription");
    assert.equal((await db.query("SELECT 1 FROM sandbox_environment_variables WHERE sandbox_id=$1", [subscriptionApi.environment_id])).rowCount, 0);
    const automated = await createEnvironmentForActor(actor, { image: `test@sha256:${"a".repeat(64)}`, code_trust: "trusted", agent_id: "claude" });
    assert.equal((await db.query("SELECT agent_configuration->>'id' AS agent FROM sandboxes WHERE id=$1", [automated.environment_id])).rows[0].agent, "claude");
    await request("/agents/codex", "PUT", { api_key: "rotated-fixture", model: "model-2" });
    assert.deepEqual((await db.query("SELECT agent_configuration FROM sandboxes WHERE id=$1", [id])).rows[0].agent_configuration, { id: "codex", model: "model-1" });
    await request("/agents/codex", "DELETE");
    assert.equal((await request("/environments", "POST", input)).status, 400);
    assert.equal((await db.query("SELECT 1 FROM sandbox_environment_variables WHERE sandbox_id=$1", [id])).rowCount, 1);
    userId = "other"; organizationId = "other-org";
    assert.equal((await request("/environments", "POST", { ...input, agent_id: "claude" })).status, 400);
    userId = "member"; organizationId = "org";
    assert.equal((await request("/agents/claude", "PUT", { api_key: "fixture" })).status, 403);
    assert.equal((await request(`/environments/${id}/ticket`, "POST", { agent: true })).status, 404);
    await db.query("INSERT INTO environment_members(sandbox_id,membership_id) VALUES ($1,'mm')", [id]);
    await db.query("UPDATE sandboxes SET state='running', runtime_id='runtime-a', compute_node_id='compute-1' WHERE id=$1", [id]);
    const ticketResponse = await request(`/environments/${id}/ticket`, "POST", { agent: true });
    assert.equal(ticketResponse.status, 200, await ticketResponse.clone().text());
    const ticket = await ticketResponse.json();
    await db.query("UPDATE compute_jobs SET status='succeeded' WHERE operation='create'");
    const gateway = new Hono<AppEnv>(); registerComputeRoutes(gateway);
    const resolve = (supports = true) => gateway.request("/api/compute/terminal/resolve", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.COMPUTE_AGENT_TOKEN}` }, body: JSON.stringify({ node_id: "compute-1", token: ticket.token, agent_sessions: supports, agent_protection: supports }) });
    assert.equal((await resolve(false)).status, 409, "old hosts must fail clearly instead of opening a shell");
    const target = await resolve();
    assert.equal(target.status, 200, await target.clone().text());
    const targetBody = await target.json();
    assert.match(targetBody.agent.protection.socket, /^driftverk-session-/);
    const {protection,...agentConfiguration}=targetBody.agent;
    assert.deepEqual(agentConfiguration, { id: "codex", model: "model-1", workspace_path: "/workspaces/project" });
    assert.equal(targetBody.environment.OPENAI_API_KEY, "fixture-codex", "existing environment retains its copied key");
    await db.query("DELETE FROM environment_members WHERE sandbox_id=$1", [id]);
    assert.equal((await resolve()).status, 403, "issued tickets recheck current membership");
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
});
