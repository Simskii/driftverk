import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

test("environment resizing validates access, state and resource limits", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_system_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098", BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000",
    SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000",
    TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000", SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000",
    COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000", MANAGED_COMPUTE_NODE_ID: "node-a",
  });
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const { db } = await import("./db.js");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await admin.query(await readFile(new URL(name, migrations), "utf8"));
    await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('user','User','resize@example.test',true);
      INSERT INTO organizations (id,name,slug,hosting_mode) VALUES ('org','Org','org','managed'),('other','Other','other','managed');
      UPDATE billing_accounts SET complimentary=true;
      INSERT INTO memberships (id,organization_id,user_id,role) VALUES ('member','org','user','admin');
      INSERT INTO sandboxes(id,preview_id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id)
      VALUES ('env',gen_random_uuid(),'org','env','image','alpine',2,4096,40,'stopped','stopped','user');`);
    const { Hono } = await import("hono");
    const { updateEnvironmentResources } = await import("./workspace.js");
    const auth = { user: { id: "user" }, session: { activeOrganizationId: "org" } } as import("./types.js").AuthSession;
    const app = new Hono<import("./types.js").AppEnv>();
    app.put("/environments/:id/resources", c => updateEnvironmentResources(c, auth));
    const resize = (body: unknown = { cpu: 4, memory_mb: 8192 }, id = "env") => app.request(`/environments/${id}/resources`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await resize()).status, 200);
    assert.deepEqual((await admin.query("SELECT cpu_count,memory_mb,state FROM sandboxes WHERE id='env'")).rows[0], { cpu_count: 4, memory_mb: 8192, state: "stopped" });
    for (const body of [null, {}, { cpu: "4", memory_mb: 8192 }, { cpu: 3, memory_mb: 8192 }, { cpu: 4, memory_mb: 0 }, { cpu: 4, memory_mb: "8192" }]) assert.equal((await resize(body)).status, 400);
    assert.equal((await resize(undefined, "missing")).status, 404);
    await admin.query("UPDATE sandboxes SET organization_id='other' WHERE id='env'");
    assert.equal((await resize()).status, 404);
    await admin.query("UPDATE sandboxes SET organization_id='org' WHERE id='env'; UPDATE memberships SET role='member'");
    assert.equal((await resize()).status, 403);
    await admin.query("UPDATE memberships SET role='admin'");
    for (const state of ['running','provisioning','degraded']) {
      await admin.query("UPDATE sandboxes SET state=$1 WHERE id='env'", [state]);
      assert.equal((await resize()).status, 409);
    }
    await admin.query("UPDATE sandboxes SET state='stopped',desired_state='running' WHERE id='env'");
    assert.equal((await resize()).status, 409);
    await admin.query("UPDATE sandboxes SET desired_state='stopped' WHERE id='env'; INSERT INTO compute_jobs(id,sandbox_id,operation,status) VALUES('job','env','start','queued')");
    assert.equal((await resize()).status, 409);
    await admin.query("UPDATE compute_jobs SET status='leased' WHERE id='job'");
    assert.equal((await resize()).status, 409);
    await admin.query("DELETE FROM compute_jobs WHERE id='job'");
    await admin.query("INSERT INTO sandbox_executions(id,sandbox_id,organization_id,compute_node_id,command,cwd,timeout_seconds) VALUES('exec','env','org','node','true','/workspace',60)");
    assert.equal((await resize()).status, 409);
    await admin.query("DELETE FROM sandbox_executions WHERE id='exec'");
    assert.equal((await resize({ cpu: 1, memory_mb: 1024 })).status, 200);
    assert.deepEqual((await admin.query("SELECT cpu_count,memory_mb FROM sandboxes WHERE id='env'")).rows[0], { cpu_count: 1, memory_mb: 1024 });
    const { environmentAction } = await import("./workspace.js");
    const { changeEnvironmentStateForActor } = await import("./environment-service.js");
    const { queueEnvironmentWake } = await import("./lifecycle.js");
    const actions = new Hono<import("./types.js").AppEnv>();
    actions.post("/environments/:id/action", c => environmentAction(c, auth));
    const actor = { organizationId: "org", organizationName: "Org", organizationSlug: "org", actorUserId: "user", automationIdPrefix: null };
    for (const source of ["web", "api"] as const) {
      const action = async (value: "start" | "stop") => {
        if (source === "api") await changeEnvironmentStateForActor(actor, "env", value);
        else assert.equal((await actions.request("/environments/env/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: value }) })).status, 202);
      };
      await admin.query("DELETE FROM compute_jobs; UPDATE sandboxes SET state='running',desired_state='running',runtime_id='runtime',manual_stop=false WHERE id='env'");
      await action("stop");
      assert.equal((await queueEnvironmentWake("env")).status, "stopped", `${source}: reconnect during stop is blocked`);
      await admin.query("UPDATE compute_jobs SET status='succeeded'; UPDATE sandboxes SET state='stopped' WHERE id='env'");
      const wakes = await Promise.all(Array.from({ length: 8 }, () => queueEnvironmentWake("env")));
      assert.ok(wakes.every(wake => wake.status === "stopped"));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM compute_jobs WHERE status='queued'")).rows[0].n, 0);
      assert.equal((await resize()).status, 200, "manual stop permits resizing despite reconnects");
      await action("start");
      assert.equal((await admin.query("SELECT manual_stop FROM sandboxes WHERE id='env'")).rows[0].manual_stop, false);
      assert.equal((await queueEnvironmentWake("env")).status, "starting");
    }
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
