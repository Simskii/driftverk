import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { Hono } from "hono";

test("Tailscale setup is scoped, persists authorization progress, and protects snapshots until logout", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await client.connect();
  const schema = `tailscale_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, { DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000" });
  const { db } = await import("./db.js");
  try {
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await client.query(await readFile(new URL(name, directory), "utf8"));
    await client.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES('user','QA','tailscale@example.test',true);
      INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'),('other','Other','other');
      INSERT INTO memberships(id,user_id,organization_id,role) VALUES('member','user','org','admin');
      UPDATE billing_accounts SET complimentary=true;
      INSERT INTO sandboxes(id,preview_id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id,runtime_id,compute_node_id,code_trust)
      VALUES('env',gen_random_uuid(),'org','env','image','dev:qa',2,4096,40,'running','running','user','runtime','compute-1','trusted'),
      ('other-env',gen_random_uuid(),'other','other','image','dev:qa',2,4096,40,'running','running','user','other-runtime','compute-1','trusted');`);
    const { environmentTailscale } = await import("./tailscale.js");
    const { reportExecution } = await import("./executions.js");
    const { createSnapshot } = await import("./catalog.js");
    const app = new Hono<any>();
    const session = { user: { id: "user" }, session: { activeOrganizationId: "org" } } as never;
    app.get("/environments/:id/tailscale", c => environmentTailscale(c, session));
    app.post("/environments/:id/tailscale", c => environmentTailscale(c, session));
    app.post("/snapshots", c => createSnapshot(c, session));
    app.post("/executions/:id/report", c => { c.set("computeAgent", { id: "compute-1", organizationId: null }); return reportExecution(c); });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const setup = (action: string, id = "env") => post(`/environments/${id}/tailscale`, { action });
    const state = async () => (await app.request("/environments/env/tailscale")).json();
    const snapshot = () => post("/snapshots", { environment_id: "env", name: `snapshot-${crypto.randomUUID().slice(0, 8)}` });
    async function report(output: object, status = "succeeded", offset = 0) {
      const id = (await client.query("SELECT tailscale_execution_id FROM sandboxes WHERE id='env'")).rows[0].tailscale_execution_id;
      const response = await post(`/executions/${id}/report`, { status, exit_code: status === "succeeded" ? 0 : null, stdout: { offset, data: Buffer.from(`${JSON.stringify(output)}\n`).toString("base64") } });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal((await setup("anything")).status, 400);
    assert.equal((await setup("connect", "other-env")).status, 404);
    await client.query("UPDATE memberships SET role='member'");
    assert.equal((await setup("connect")).status, 403);
    await client.query("UPDATE memberships SET role='admin'; UPDATE sandboxes SET code_trust='untrusted' WHERE id='env'");
    assert.equal((await setup("connect")).status, 403);
    await client.query("UPDATE sandboxes SET code_trust='trusted' WHERE id='env'");
    assert.equal((await setup("connect")).status, 202);
    assert.equal((await setup("connect")).status, 409, "duplicate setup cannot start another execution");
    const progress = { state: "needs_login", auth_url: "https://login.tailscale.com/a/abc123" };
    await report(progress, "running");
    assert.equal((await state()).auth_url, progress.auth_url);
    assert.equal((await state()).pending, true);
    assert.equal((await snapshot()).status, 409, "an in-progress setup cannot be snapshotted");
    await report({ state: "connected", hostname: "env.tail.ts.net", ips: ["100.64.0.1"] }, "succeeded", Buffer.byteLength(`${JSON.stringify(progress)}\n`));
    assert.equal((await state()).state, "connected");
    assert.equal((await snapshot()).status, 409, "authenticated identity cannot be copied");
    assert.equal((await setup("logout")).status, 202);
    await report({ state: "logged_out" });
    assert.equal((await client.query("SELECT tailscale_configured FROM sandboxes WHERE id='env'")).rows[0].tailscale_configured, false, "logout works without a browser GET");
    await client.query("UPDATE sandboxes SET state='stopped' WHERE id='env'");
    assert.equal((await snapshot()).status, 202);
    await client.query("UPDATE sandboxes SET state='running' WHERE id='env'");
    await client.query("DELETE FROM compute_jobs WHERE sandbox_id='env'");
    assert.equal((await setup("connect")).status, 202);
    await report({ state: "not_installed" });
    assert.equal((await state()).state, "not_installed");
    assert.equal((await client.query("SELECT tailscale_configured FROM sandboxes WHERE id='env'")).rows[0].tailscale_configured, false);
  } finally {
    await db.end();
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
});
