import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("authenticated access wakes once, waits through stop, and needs no port telemetry", {
  skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL,
}, async () => {
  const schema = `wake_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const connection = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  connection.searchParams.set("options", `-csearch_path=${schema}`);
  process.env.DATABASE_URL = connection.href;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-000000000";
  process.env.SECRET_ENCRYPTION_KEYS = "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  process.env.PREVIEW_TOKEN_SECRET = "test-preview-secret-0000000000000";
  process.env.TERMINAL_TOKEN_SECRET = "test-terminal-secret-000000000000";
  process.env.SSH_TOKEN_SECRET = "test-ssh-secret-000000000000000000";
  process.env.COMPUTE_AGENT_TOKEN = "test-compute-secret-0000000000000";
  process.env.MANAGED_COMPUTE_NODE_ID = "node-a";
  const { db } = await import("./db.js");
  const { queueEnvironmentWake } = await import("./lifecycle.js");
  const { createPreviewGrant } = await import("./preview.js");
  const { registerComputeRoutes } = await import("./compute.js");
  const { createPreviewToken } = await import("./preview-token.js");
  const { createSshToken } = await import("./ssh-token.js");
  const { createTerminalToken } = await import("./terminal-token.js");
  const app = new Hono<AppEnv>();
  registerComputeRoutes(app);
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE sandboxes (manual_stop boolean NOT NULL DEFAULT false,
        id text PRIMARY KEY, runtime_id text, state text, desired_state text, agent_configuration jsonb, workspace_path text,
        compute_node_id text, preview_id text, organization_id text, snapshot_id text,
        preview_enabled boolean NOT NULL DEFAULT true, ssh_enabled boolean NOT NULL DEFAULT true,
        purpose text DEFAULT 'development', prebuild_id text, initialization_command text, startup_command text, readiness_command text, code_trust text DEFAULT 'trusted', last_activity_at timestamptz DEFAULT now(),
        updated_at timestamptz, provisioning_step text, error_message text, repository text, setup_command text
      );
      CREATE TABLE compute_jobs (id text PRIMARY KEY, sandbox_id text, operation text, status text, provisioning_step text, auto_stop boolean NOT NULL DEFAULT false);
      CREATE TABLE sandbox_logs (sandbox_id text, event_hash text, recorded_at timestamptz, severity text, message text);
      CREATE TABLE sandbox_environment_variables (sandbox_id text, name text, encrypted_value text, iv text);
      CREATE TABLE workspace_snapshots (id text PRIMARY KEY, organization_id text, source_sandbox_id text, status text, artifact_ref text);
      INSERT INTO sandboxes (id, runtime_id, state, desired_state, compute_node_id, preview_id, organization_id)
      VALUES ('env', 'abcdef123456', 'stopped', 'stopped', 'node-a', 'preview-a', 'org-a');
    `);
    await db.query("CREATE TABLE billing_accounts(organization_id text,complimentary boolean,paid_until timestamptz,trial_ends_at timestamptz,setup_sandbox_id text,setup_started_at timestamptz,balance_ore numeric); INSERT INTO billing_accounts(organization_id,complimentary) VALUES('org-a',true); CREATE TABLE organizations(id text,hosting_mode text)");
    await db.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      INSERT INTO "user" VALUES ('user-a');
      CREATE TABLE memberships(id text PRIMARY KEY, organization_id text, user_id text, role text);
      INSERT INTO memberships VALUES ('member-a','org-a','user-a','admin');
      CREATE TABLE user_ssh_keys(user_id text, fingerprint text);
      INSERT INTO user_ssh_keys VALUES ('user-a','SHA256:qa');`);
    await db.query(await readFile(new URL("../migrations/0045_environment_members.sql", import.meta.url), "utf8"));
    const billingSql = await readFile(new URL("../migrations/0026_billing.sql",import.meta.url),"utf8");
    await db.query(billingSql.slice(billingSql.indexOf("CREATE FUNCTION billing_access("),billingSql.indexOf("CREATE FUNCTION billing_setup_configuration(")));
    async function reset(state = "stopped", desired = state) {
      await db.query("DELETE FROM compute_jobs");
      await db.query("UPDATE sandboxes SET state = $1, desired_state = $2", [state, desired]);
    }
    async function post(path: string, body: object) {
      return app.request(`/api/compute/${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.COMPUTE_AGENT_TOKEN}` },
        body: JSON.stringify({ node_id: "node-a", ...body }),
      });
    }
    const wakes = await Promise.all(Array.from({ length: 12 }, () => queueEnvironmentWake("env", "node-a")));
    assert.ok(wakes.every(wake => wake.status === "starting"));
    assert.equal((await db.query("SELECT count(*)::int AS count FROM compute_jobs")).rows[0].count, 1);
    await db.query("INSERT INTO workspace_snapshots VALUES ('local-snapshot', 'org-a', 'env', 'ready', 'driftverk/snapshot-local-snapshot:latest'), ('remote-snapshot', 'org-a', 'env', 'ready', 's3://bucket/remote')");
    await db.query("UPDATE sandboxes SET state = 'deleted', desired_state = 'deleted' WHERE id = 'env'");
    const protectedResponse = await post("images/protected", {});
    assert.equal(protectedResponse.status, 200);
    assert.deepEqual((await protectedResponse.json()).protected_snapshot_ids, ["local-snapshot"]);
    await reset("provisioning", "stopped");
    await db.query("INSERT INTO compute_jobs VALUES ('stop', 'env', 'stop', 'leased', 'allocating')");
    assert.equal((await queueEnvironmentWake("env", "node-a")).status, "starting");
    assert.equal((await db.query("SELECT count(*)::int AS count FROM compute_jobs")).rows[0].count, 1);
    await reset();
    assert.equal((await queueEnvironmentWake("env", "node-b")).status, "unavailable");
    await reset("degraded", "running");
    assert.equal((await queueEnvironmentWake("env")).status, "unavailable");
    await reset("provisioning", "deleted");
    assert.equal((await queueEnvironmentWake("env")).status, "unavailable");
    await reset();
    const expiresAt = Date.now() + 60_000;
    const token = createPreviewToken({ sandboxId: "env", nodeId: "node-a", port: 3000, expiresAt }, process.env.PREVIEW_TOKEN_SECRET);
    const wrongNode = createPreviewToken({ sandboxId: "env", nodeId: "node-b", port: 3000, expiresAt }, process.env.PREVIEW_TOKEN_SECRET);
    assert.equal((await post("preview/resolve", { preview_id: "preview-a", port: 3000, token: wrongNode })).status, 403);
    assert.equal((await post("preview/resolve", { preview_id: "wrong", port: 3000, token })).status, 404);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM compute_jobs")).rows[0].count, 0);
    assert.equal((await post("preview/resolve", { preview_id: "preview-a", port: 3000, token })).status, 202);
    await reset("running");
    assert.equal((await post("preview/resolve", { preview_id: "preview-a", port: 3000, token })).status, 200);
    // Deliberately no sandbox_ports table: a known port must work before telemetry.
    assert.match((await createPreviewGrant("org-a", "env", 3000)).url, /3000-preview-a/);
    await assert.rejects(createPreviewGrant("org-b", "env", 3000), /provisioned/);
    await db.query("UPDATE sandboxes SET preview_enabled = false WHERE id = 'env'");
    await assert.rejects(createPreviewGrant("org-a", "env", 3000), /disabled/);
    assert.equal((await post("preview/resolve", { preview_id: "preview-a", port: 3000, token })).status, 404);
    await db.query("UPDATE sandboxes SET preview_enabled = true WHERE id = 'env'");
    const sshTicket = createSshToken({ userId: "user-a", fingerprint: "SHA256:qa", sandboxId: "env", nodeId: "node-a", expiresAt, nonce: crypto.randomUUID() }, process.env.SSH_TOKEN_SECRET);
    const terminalToken = createTerminalToken({ userId: "user-a", sandboxId: "env", nodeId: "node-a", expiresAt, nonce: crypto.randomUUID() }, process.env.TERMINAL_TOKEN_SECRET);
    for (const [path, credentials] of [["ssh/resolve", { ticket: sshTicket }], ["terminal/resolve", { token: terminalToken }]] as const) {
      await reset();
      assert.equal((await post(path, credentials)).status, 202);
      await reset("running");
      const resolved = await post(path, credentials);
      assert.equal(resolved.status, 200);
      assert.equal((await resolved.json()).runtime_id, "abcdef123456");
    }
    await reset();
    await db.query("UPDATE sandboxes SET manual_stop=true");
    for (const [path, credentials] of [
      ["ssh/resolve", { ticket: sshTicket }],
      ["terminal/resolve", { token: terminalToken }],
      ["preview/resolve", { preview_id: "preview-a", port: 3000, token }],
    ] as const) {
      const response = await post(path, credentials);
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /stopped manually/);
    }
    await assert.rejects(createPreviewGrant("org-a", "env", 3000), /stopped manually/);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM compute_jobs")).rows[0].count, 0);
    await db.query("UPDATE sandboxes SET manual_stop=false");
    await reset("running");
    await db.query("UPDATE sandboxes SET ssh_enabled=false");
    assert.equal((await post("ssh/resolve", { ticket: sshTicket })).status, 403, "an already-issued SSH ticket is revoked");
    assert.equal((await post("terminal/resolve", { token: terminalToken })).status, 200, "web terminal remains available");
    await reset();
    assert.equal((await post("ssh/resolve", { ticket: sshTicket })).status, 403);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM compute_jobs")).rows[0].count, 0, "disabled SSH cannot wake an environment");
    await reset("running");
    await db.query("UPDATE sandboxes SET last_activity_at = now() - interval '1 hour'");
    assert.equal((await post("activity", { sandbox_id: "env" })).status, 200);
    assert.equal((await db.query("SELECT last_activity_at > now() - interval '10 seconds' AS active FROM sandboxes")).rows[0].active, true);
    assert.equal((await post("activity", { sandbox_id: "other-env" })).status, 404);
  } finally {
    // This unique schema contains only fixtures created above.
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
