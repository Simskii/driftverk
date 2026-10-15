import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("environment assignments enforce tenant boundaries, direct routes, SSH tickets, OAuth reads and revocation", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const schema = `access_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const connection = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  connection.searchParams.set("options", `-csearch_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: connection.href, BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "test-better-auth-secret-000000000",
    SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", PREVIEW_TOKEN_SECRET: "test-preview-secret-0000000000000",
    TERMINAL_TOKEN_SECRET: "test-terminal-secret-000000000000", SSH_TOKEN_SECRET: "test-ssh-secret-000000000000000000",
    COMPUTE_AGENT_TOKEN: "test-compute-secret-0000000000000", MANAGED_COMPUTE_NODE_ID: "compute-1",
  });
  const { authenticateApiKey } = await import("./api-keys.js");
  const { db } = await import("./db.js");
  const { migrate } = await import("./migrate.js");
  const { requireEnvironmentAccess, setEnvironmentMember, environmentMembers, memberEnvironments, hasEnvironmentAccess } = await import("./environment-access.js");
  const { listEnvironments, getEnvironment, getEnvironmentTelemetry } = await import("./workspace.js");
  const { listEnvironmentsForActor, getEnvironmentForActor } = await import("./environment-service.js");
  const { createTerminalTicket } = await import("./terminal.js");
  const { registerComputeRoutes } = await import("./compute.js");
  const { createPreview } = await import("./preview.js");
  const { preparedPreviewSettings } = await import("./prepared-previews.js");
  const { listTeam } = await import("./team.js");
  const { listSnapshots } = await import("./catalog.js");
  const { getExecution, executionArtifact } = await import("./executions.js");
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await migrate();
    await db.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('admin','Admin','admin@access.test',true),('member','Member','member@access.test',true),('outsider','Other','other@access.test',true);
      INSERT INTO organizations (id,name,slug) VALUES ('org','Access QA','access-qa'),('other','Other','other');
      INSERT INTO memberships (id,organization_id,user_id,role) VALUES ('ma','org','admin','admin'),('mm','org','member','member'),('mo','other','outsider','admin');
      UPDATE billing_accounts SET complimentary=true WHERE organization_id='org';
      INSERT INTO sandboxes (id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id,compute_node_id,runtime_id,preview_id)
      VALUES ('env-a','org','alpha','image','test:1',1,1024,20,'running','running','admin','compute-1','runtime-a',gen_random_uuid()),('env-b','org','beta','image','test:1',1,1024,20,'running','running','admin','compute-1','runtime-b',gen_random_uuid()),('env-other','other','other','image','test:1',1,1024,20,'running','running','outsider','compute-1','runtime-c',gen_random_uuid());
      INSERT INTO user_ssh_keys (id,user_id,name,public_key,fingerprint) VALUES ('key','member','QA','test','SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      INSERT INTO sandbox_executions (id,sandbox_id,organization_id,compute_node_id,command,cwd,timeout_seconds,artifact_paths) VALUES ('exec-b','env-b','org','compute-1','pwd','/workspace',30,'[]');
    `);
    let userId = "admin";
    const app = new Hono<AppEnv>();
    app.use("/api/*", async (c,next) => { c.set("authSession", { user: { id: userId }, session: { activeOrganizationId: "org" } } as never); await next(); });
    app.use("/api/environments/:id", requireEnvironmentAccess);
    app.use("/api/environments/:id/*", requireEnvironmentAccess);
    app.get("/api/environments", c => listEnvironments(c,c.get("authSession")));
    app.get("/api/environments/:id", c => getEnvironment(c,c.get("authSession")));
    app.get("/api/environments/:id/telemetry", c => getEnvironmentTelemetry(c,c.get("authSession")));
    app.post("/api/environments/:id/terminal-ticket", c => createTerminalTicket(c,c.get("authSession")));
    app.post("/api/environments/:id/ports/:port/preview", c => createPreview(c,c.get("authSession")));
    app.get("/api/environments/:id/members", environmentMembers);
    app.put("/api/environments/:id/members/:memberId", setEnvironmentMember);
    app.get("/api/team", c => listTeam(c,c.get("authSession")));
    app.get("/api/team/:memberId/environments", memberEnvironments);
    app.get("/api/environment-templates/:id/prepared-preview", preparedPreviewSettings);
    app.get("/api/snapshots", c => listSnapshots(c,c.get("authSession")));
    const put = (env: string, member: string, value: unknown) => app.request(`/api/environments/${env}/members/${member}`, { method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify({has_access:value}) });
    const list = async () => ((await (await app.request('/api/environments')).json()).environments as {id:string}[]).map(row=>row.id).sort();
    assert.deepEqual(await list(), ['env-a','env-b']);
    assert.equal((await put('env-a','mm',true)).status,200);
    assert.equal((await put('env-a','mm',true)).status,200);
    assert.equal((await put('env-a','mo',true)).status,404);
    assert.equal((await put('env-other','mm',true)).status,404);
    assert.equal((await put('env-a','ma',false)).status,400);
    assert.equal((await put('env-a','mm','true')).status,400);
    assert.equal((await app.request('/api/team/mo/environments')).status,404);
    assert.equal((await app.request('/api/environments/env-a/members')).status,200);
    userId='member';
    assert.deepEqual(await list(), ['env-a']);
    assert.equal((await app.request('/api/environment-templates/private/prepared-preview')).status,403);
    assert.equal((await app.request('/api/environments/env-a')).status,200);
    assert.equal((await app.request('/api/environments/env-b')).status,404);
    assert.equal((await app.request('/api/environments/env-b/telemetry')).status,404);
    assert.equal((await app.request('/api/environments/env-b/terminal-ticket',{method:'POST'})).status,404);
    assert.equal((await app.request('/api/environments/env-b/ports/3000/preview',{method:'POST'})).status,404);
    assert.equal((await put('env-a','mm',false)).status,403);
    assert.equal((await app.request('/api/team/mm/environments')).status,403);
    const team = await (await app.request('/api/team')).json();
    assert.equal(team.members.find((member: {id:string}) => member.id === 'mm').environment_count,1);
    assert.equal(team.members.find((member: {id:string}) => member.id === 'ma').environment_count,2);
    const actor = { organizationId:'org', organizationName:'Access QA',organizationSlug:'access-qa',actorUserId:'member',automationIdPrefix:null,accessUserId:'member' };
    assert.deepEqual((await listEnvironmentsForActor(actor)).map(row=>row.id),['env-a']);
    await assert.rejects(getEnvironmentForActor(actor,'env-b'), /not found/);
    await assert.rejects(getExecution(actor,'exec-b'), /not found/);
    await assert.rejects(executionArtifact(actor,'exec-b','file.txt'), /not found/);
    const terminal = await (await app.request('/api/environments/env-a/terminal-ticket',{method:'POST'})).json();
    assert.ok(terminal.token);
    const preview = await (await app.request('/api/environments/env-a/ports/3000/preview',{method:'POST'})).json();
    const previewToken = new URL(preview.url).searchParams.get('token');
    const gateway = new Hono<AppEnv>(); registerComputeRoutes(gateway);
    const post = (path:string,body:object,gatewayAuth=false) => gateway.request(path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${gatewayAuth ? process.env.SSH_TOKEN_SECRET : process.env.COMPUTE_AGENT_TOKEN}`},body:JSON.stringify(body)});
    const authorize = (name:string) => post('/api/gateway/ssh/authorize',{target:`access-qa.${name}`,fingerprint:'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},true);
    assert.equal((await authorize('beta')).status,403);
    const ssh = await (await authorize('alpha')).json(); assert.ok(ssh.ticket);
    assert.equal((await post('/api/compute/ssh/resolve',{node_id:'compute-1',ticket:ssh.ticket})).status,200);
    assert.equal((await post('/api/compute/terminal/resolve',{node_id:'compute-1',token:terminal.token})).status,200);
    userId='admin'; assert.equal((await put('env-a','mm',false)).status,200);
    assert.equal((await authorize('alpha')).status,403);
    assert.equal((await post('/api/compute/ssh/resolve',{node_id:'compute-1',ticket:ssh.ticket})).status,403);
    assert.equal((await post('/api/compute/terminal/resolve',{node_id:'compute-1',token:terminal.token})).status,403);
    const previewId = (await db.query("SELECT preview_id FROM sandboxes WHERE id='env-a'")).rows[0].preview_id;
    assert.equal((await post('/api/compute/preview/resolve',{node_id:'compute-1',preview_id:previewId,port:3000,token:previewToken})).status,403);
    userId='member'; assert.deepEqual(await list(),[]);
    // Current role is evaluated, and removing membership prevents stale assignments reappearing on rejoin.
    await db.query("UPDATE memberships SET role='admin' WHERE id='mm'");
    assert.deepEqual(await list(),['env-a','env-b']);
    await db.query("UPDATE memberships SET role='member' WHERE id='mm'");
    assert.deepEqual(await list(),[]);
    userId='admin'; await put('env-a','mm',true);
    await db.query("DELETE FROM memberships WHERE id='mm'; INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('mm-new','org','member','member')");
    assert.equal(await hasEnvironmentAccess('env-a','member'),false);
    assert.equal(await hasEnvironmentAccess('env-other','admin'),false);
    const keyId = `key_${"a".repeat(32)}`, secret = "b".repeat(43);
    await db.query("INSERT INTO api_keys(id,organization_id,name,secret_hash,secret_prefix,scopes,created_by_user_id) VALUES ($1,'org','QA',$2,'test',ARRAY['read'],'admin')", [keyId, createHash('sha256').update(secret).digest('hex')]);
    const request = new Request('http://localhost/v1/environments', { headers: { authorization: `Bearer dvk_live_${keyId}.${secret}` } });
    assert.ok(await authenticateApiKey(request));
    await db.query("UPDATE memberships SET role='member' WHERE id='ma'");
    assert.equal(await authenticateApiKey(request),null);

  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
