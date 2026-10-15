import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("personal ChatGPT connections: login, two environments, refresh, revocation and reconnect", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const schema = `connections_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const directory = await mkdtemp(join(tmpdir(), "driftverk-auth-test-"));
  const binary = join(directory, "codex-fixture");
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
  const credentials = { auth_mode: "chatgpt", tokens: { access_token: accessToken, refresh_token: "fixture-refresh-private", id_token: "fixture-id", account_id: "fixture-account" } };
  // Actual stdio subprocess protocol, no provider traffic or real credentials.
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const reply=result=>console.log(JSON.stringify({id:m.id,result}));
 if(m.method==='initialize')reply({});
 if(m.method==='account/login/start'){
  reply({type:'chatgptDeviceCode',userCode:'TEST-CODE',verificationUrl:'https://auth.openai.com/codex/device',loginId:'fixture'});
  setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify(${JSON.stringify(credentials)}));
   console.log(JSON.stringify({method:'account/login/completed',params:{success:true}}));},100);
 }
 if(m.method==='account/read'){
  fs.appendFileSync(${JSON.stringify(join(directory, "refreshes"))},'refresh\\n');
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify(${JSON.stringify(credentials)}));
  reply({account:{type:'chatgpt'}});
 }
});
`, { mode: 0o700 });
  Object.assign(process.env, {
    DATABASE_URL: url.href, BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "test-better-auth-secret-000000000",
    SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", PREVIEW_TOKEN_SECRET: "test-preview-secret-0000000000000",
    TERMINAL_TOKEN_SECRET: "test-terminal-secret-000000000000", SSH_TOKEN_SECRET: "test-ssh-secret-000000000000000000",
    COMPUTE_AGENT_TOKEN: "test-compute-secret-0000000000000", MANAGED_COMPUTE_NODE_ID: "compute-1", CODEX_AUTH_BINARY: binary,
  });
  const { db } = await import("./db.js");
  const { migrate } = await import("./migrate.js");
  const { agents, resolveAgentSetup } = await import("./agents.js");
  const { agentConnection, agentCredential, connectionCredentials, signAgentCredentialGrant } = await import("./agent-connections.js");
  const { createEnvironment } = await import("./workspace.js");
  const { createEnvironmentForActor } = await import("./environment-service.js");
  const { createTerminalTicket } = await import("./terminal.js");
  const { requireEnvironmentAccess } = await import("./environment-access.js");
  const { registerComputeRoutes } = await import("./compute.js");
  const { encryptSecret, secretContext } = await import("./secrets.js");
  let userId = "owner";
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("authSession", { user: { id: userId }, session: { activeOrganizationId: "org" } } as never); await next(); });
  app.get("/agents", agents);
  app.on(["GET", "POST", "PUT", "DELETE"], "/connection", agentConnection);
  app.post("/credential", agentCredential);
  app.post("/environments", c => createEnvironment(c, c.get("authSession")));
  app.use("/environments/:id/*", requireEnvironmentAccess);
  app.post("/environments/:id/ticket", c => createTerminalTicket(c, c.get("authSession")));
  const request = (path: string, method = "GET", body: object = {}) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  const login = async () => {
    const start = await request("/connection", "POST");
    assert.equal(start.status, 200, await start.clone().text());
    assert.equal((await start.json()).user_code, "TEST-CODE");
    for (let i = 0; i < 60; i++) {
      if ((await (await request("/connection")).json()).status === "connected") return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("fixture login did not finish");
  };
  try {
    await db.query(`CREATE SCHEMA ${schema}`); await migrate();
    await db.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('owner','Owner','owner@connections.test',true),('other','Other','other@connections.test',true);
      INSERT INTO organizations(id,name,slug) VALUES ('org','QA','connections-qa');
      INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('mo','org','owner','admin'),('mx','org','other','admin');
      UPDATE billing_accounts SET complimentary=true;`);
    await login();
    assert.equal((await request("/connection", "POST")).status, 429);
    const stored = (await db.query("SELECT * FROM user_agent_connections")).rows[0];
    assert.ok(!JSON.stringify(stored).includes("fixture-refresh-private"));
    const listing = await (await request("/agents")).json();
    assert.equal(listing.agents[0].subscription_connected, true);
    assert.equal(listing.agents[0].default_auth_method, "subscription");
    assert.ok(!JSON.stringify(listing).includes("fixture-refresh-private"));
    assert.equal((await request("/connection", "PUT", { model: "fixture-model", is_default: true })).status, 200);
    const environments: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await request("/environments", "POST", { image: "test:1", agent_id: "codex", agent_auth_method: "subscription" });
      assert.equal(response.status, 202, await response.clone().text());
      environments.push((await response.json()).id);
    }
    const created = (await db.query("SELECT agent_configuration FROM sandboxes WHERE id=ANY($1)", [environments])).rows;
    assert.ok(created.every(row => row.agent_configuration.connection_id === stored.id));
    assert.equal((await db.query("SELECT 1 FROM sandbox_environment_variables WHERE sandbox_id=ANY($1)", [environments])).rowCount, 0);
    await assert.rejects(createEnvironmentForActor({ organizationId: "org", organizationName: "QA", organizationSlug: "qa", actorUserId: "owner", automationIdPrefix: null },
      { image: `test@sha256:${"a".repeat(64)}`, code_trust: "trusted", agent_id: "codex", agent_auth_method: "subscription" }), /Sign in/);
    await assert.rejects(resolveAgentSetup("org", "codex", true, [], db, "subscription", "other"), /Connect ChatGPT/);
    await db.query("UPDATE sandboxes SET state='running',desired_state='running',compute_node_id='compute-1',runtime_id='runtime-1' WHERE id=$1", [environments[0]]);
    await db.query("UPDATE compute_jobs SET status='succeeded' WHERE operation='create'");
    const gateway = new Hono<AppEnv>(); registerComputeRoutes(gateway);
    const ticket = await (await request(`/environments/${environments[0]}/ticket`, "POST", { agent: true })).json();
    const target = await gateway.request("/api/compute/terminal/resolve", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.COMPUTE_AGENT_TOKEN}` }, body: JSON.stringify({ node_id: "compute-1", token: ticket.token, agent_sessions: true, agent_protection: true, agent_credentials: true }) });
    assert.equal(target.status, 200, await target.clone().text());
    const targetBody = await target.json();
    assert.ok(!JSON.stringify(targetBody).includes("fixture-refresh-private"));
    const token = targetBody.agent_connection.token;
    const credential = (value = token) => app.request("/credential", { method: "POST", headers: { authorization: `Bearer ${value}` } });
    assert.equal((await credential()).status, 200);
    assert.equal((await credential(ticket.token)).status, 401, "terminal and credential grants are not interchangeable");
    const expired = { ...credentials, tokens: { ...credentials.tokens, access_token: "expired" } };
    const encrypted = encryptSecret(JSON.stringify(expired), secretContext.agentConnection("owner"));
    await db.query("UPDATE user_agent_connections SET encrypted_value=$2,iv=$3 WHERE id=$1", [stored.id, encrypted.encryptedValue, encrypted.iv]);
    await Promise.all([connectionCredentials(stored.id, "owner"), connectionCredentials(stored.id, "owner")]);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(directory, "refreshes"), "utf8"), "refresh\n", "concurrent requests refresh once");
    await db.query("UPDATE sandboxes SET runtime_id='replacement' WHERE id=$1", [environments[0]]);
    assert.equal((await credential()).status, 403, "grant is bound to its runtime");
    await db.query("UPDATE sandboxes SET runtime_id='runtime-1' WHERE id=$1", [environments[0]]);
    userId = "other";
    assert.equal((await (await request("/agents")).json()).agents[0].subscription_connected, false);
    await request("/connection", "DELETE");
    assert.equal((await credential()).status, 200, "another user cannot disconnect the owner");
    userId = "owner";
    await request("/connection", "DELETE");
    assert.equal((await credential()).status, 403);
    await login();
    const reconnected = (await db.query("SELECT * FROM user_agent_connections WHERE user_id='owner'")).rows[0];
    assert.equal(reconnected.id, stored.id, "existing environments retain their connection");
    assert.notEqual(reconnected.generation, stored.generation);
    assert.equal((await credential()).status, 403, "old grants remain revoked after reconnect");
    const current = signAgentCredentialGrant({ sandboxId: environments[0]!, nodeId: "compute-1", runtimeId: "runtime-1", connectionId: stored.id,
      userId: "owner", accountId: "fixture-account", generation: reconnected.generation, expiresAt: Date.now() + 60_000, nonce: "fixture" });
    assert.equal((await credential(current)).status, 200);
    const expiredGrant = signAgentCredentialGrant({ sandboxId: environments[0]!, nodeId: "compute-1", runtimeId: "runtime-1", connectionId: stored.id,
      userId: "owner", accountId: "fixture-account", generation: reconnected.generation, expiresAt: Date.now() - 1, nonce: "expired" });
    assert.equal((await credential(expiredGrant)).status, 401);
    await db.query("DELETE FROM memberships WHERE user_id='owner'");
    assert.equal((await credential(current)).status, 403, "membership is checked again on refresh");
    await request("/connection", "DELETE");
    assert.equal((await request("/connection", "POST")).status, 200);
    await request("/connection", "DELETE");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await db.query("SELECT 1 FROM user_agent_connections WHERE encrypted_value IS NOT NULL")).rowCount, 0, "cancel fences late login completion");
    assert.equal((await request("/connection", "PUT", { is_default: true })).status, 409);
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
