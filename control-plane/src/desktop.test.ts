import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("desktop startup and status enforce membership, environment binding and fixed command", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `desktop_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, { DATABASE_URL: url.href, BETTER_AUTH_URL: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000" });
  const { db } = await import("./db.js");
  try {
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await admin.query(await readFile(new URL(name, directory), "utf8"));
    await admin.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES('owner','Owner','owner@desktop.test',true),('member','Member','member@desktop.test',true);
      INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'),('other','Other','other');
      INSERT INTO memberships(id,user_id,organization_id,role) VALUES('owner-membership','owner','org','admin'),('membership','member','org','member');
      UPDATE billing_accounts SET complimentary=true;
      INSERT INTO sandboxes(id,preview_id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id,runtime_id,compute_node_id)
      VALUES('env',gen_random_uuid(),'org','env','image','dev:qa',2,4096,40,'running','running','owner','runtime','compute-1'),
      ('second',gen_random_uuid(),'org','second','image','dev:qa',2,4096,40,'running','running','owner','runtime2','compute-1'),
      ('other-env',gen_random_uuid(),'other','other','image','dev:qa',2,4096,40,'running','running','owner','other-runtime','compute-1');`);
    const { environmentDesktop, desktopStartCommand, desktopStopCommand } = await import("./desktop.js");
    const app = new Hono<AppEnv>();
    const session = { user: { id: "member" }, session: { activeOrganizationId: "org" } } as never;
    app.get("/environments/:id/desktop", c => environmentDesktop(c, session));
    app.post("/environments/:id/desktop", c => environmentDesktop(c, session));
    const start = (id = "env") => app.request(`/environments/${id}/desktop`, { method: "POST" });
    const state = (execution: string, id = "env") => app.request(`/environments/${id}/desktop?execution=${execution}`);
    assert.equal((await start()).status, 404);
    await admin.query("INSERT INTO environment_members(sandbox_id,membership_id) VALUES('env','membership'),('second','membership')");
    assert.equal((await start("other-env")).status, 404);
    const response = await start();
    assert.equal(response.status, 202, await response.clone().text());
    const { execution_id: id } = await response.json();
    assert.equal((await start()).status, 409, "do not start a second concurrent execution");
    assert.equal((await (await state(id)).json()).pending, true);
    assert.equal((await state(id, "second")).status, 404);
    assert.equal((await admin.query("SELECT command FROM sandbox_executions WHERE id=$1", [id])).rows[0].command, desktopStartCommand);
    await admin.query("UPDATE sandbox_executions SET status='failed',exit_code=42 WHERE id=$1", [id]);
    assert.match((await (await state(id)).json()).error, /not installed/);
    await admin.query("UPDATE sandbox_executions SET status='succeeded',exit_code=0 WHERE id=$1", [id]);
    assert.equal((await (await state(id)).json()).ready, true);
    await admin.query("UPDATE sandbox_executions SET command='pwd' WHERE id=$1", [id]);
    assert.equal((await state(id)).status, 404);
    const stop = await app.request('/environments/env/desktop?action=stop', { method: 'POST' });
    assert.equal(stop.status, 202);
    const stopId = (await stop.json()).execution_id;
    assert.equal((await admin.query("SELECT command FROM sandbox_executions WHERE id=$1", [stopId])).rows[0].command, desktopStopCommand);
    await admin.query("UPDATE sandbox_executions SET status='failed',exit_code=1 WHERE id=$1", [stopId]);
    assert.match((await (await state(stopId)).json()).error, /active prompt/);
    await admin.query("UPDATE sandbox_executions SET status='succeeded',exit_code=0 WHERE id=$1", [stopId]);
    assert.equal((await (await state(stopId)).json()).ready, true);
    assert.equal((await app.request('/environments/env/desktop?action=arbitrary', { method: 'POST' })).status, 400);
    await admin.query("DELETE FROM environment_members WHERE sandbox_id='env'");
    assert.equal((await state(id)).status, 404, "revocation also protects status");
    assert.equal((await start()).status, 404);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
