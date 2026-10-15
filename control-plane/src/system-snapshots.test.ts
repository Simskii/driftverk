import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

test("system and filesystem snapshots preserve launch defaults and workspace isolation", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
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
    const { listSystemSnapshots, resolveSystemSnapshot } = await import("./system-snapshots.js");
    assert.deepEqual(await listSystemSnapshots(), []);
    const image = `ghcr.io/simskii/dev@sha256:${"a".repeat(64)}`;
    await admin.query("INSERT INTO system_snapshots VALUES ('sys_dev-1', 'Driftverk Dev', '2026.09.1', $1, true, now())", [image]);
    await assert.rejects(admin.query("INSERT INTO system_snapshots VALUES ('sys_dev-2', 'Driftverk Dev', '2026.09.2', $1, true, now())", [image]), /unique/);
    await assert.rejects(admin.query("INSERT INTO system_snapshots VALUES ('sys_bad', 'Bad', 'bad', 'ghcr.io/simskii/dev:latest', false, now())"), /check constraint/);
    assert.equal((await listSystemSnapshots())[0].is_system, true);
    const selected = { source_type: "snapshot", snapshot_id: "sys_dev-1", cpu: 4 };
    assert.deepEqual(await resolveSystemSnapshot(selected), { source_type: "image", image, snapshot_id: undefined, registry_id: undefined, cpu: 4 });
    assert.equal(selected.source_type, "snapshot");
    await assert.rejects(resolveSystemSnapshot({ ...selected, snapshot_id: "sys_missing" }), /does not exist/);
    await assert.rejects(resolveSystemSnapshot({ ...selected, registry_id: "customer-registry" }), /cannot be combined/);
    const privateInput = { source_type: "snapshot", snapshot_id: "snap_private" };
    assert.equal(await resolveSystemSnapshot(privateInput), privateInput);
    await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('user','User','system@example.test',true);
      INSERT INTO organizations (id,name,slug,hosting_mode) VALUES ('org','Org','org','managed'), ('other','Other','other','managed');
      UPDATE billing_accounts SET complimentary=true;
      INSERT INTO workspace_snapshots (id,organization_id,name,version,status,base_image,created_by_user_id) VALUES ('snap_private','org','Private','1','ready','ubuntu:24.04','user');`);
    const actor = { organizationId: "org", organizationName: "Org", organizationSlug: "org", actorUserId: "user", automationIdPrefix: null };
    const { listSnapshotsForActor, createEnvironmentForActor } = await import("./environment-service.js");
    assert.deepEqual((await listSnapshotsForActor(actor)).map(row => row.id), ["sys_dev-1", "snap_private"]);
    assert.deepEqual((await listSnapshotsForActor({ ...actor, organizationId: "other" })).map(row => row.id), ["sys_dev-1"]);
    await assert.rejects(createEnvironmentForActor({ ...actor, organizationId: "other" }, { ...privateInput, code_trust: "trusted" }), /not ready or does not exist/);
    const environment = await createEnvironmentForActor(actor, { ...selected, code_trust: "trusted" });
    assert.deepEqual((await admin.query("SELECT source_type, source_image, snapshot_id FROM sandboxes WHERE id=$1", [environment.environment_id])).rows[0], { source_type: "image", source_image: image, snapshot_id: null });
    await admin.query("INSERT INTO memberships (id,organization_id,user_id,role) VALUES ('member','org','user','admin')");
    const { Hono } = await import("hono");
    const { environmentTemplates } = await import("./environment-templates.js");
    const app = new Hono<import("./types.js").AppEnv>();
    app.use("*", async (c, next) => {
      c.set("authSession", { user: { id: "user" }, session: { activeOrganizationId: "org" } } as import("./types.js").AuthSession);
      await next();
    });
    app.post("/templates", environmentTemplates);
    const response = await app.request("/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "System based", configuration: selected }) });
    assert.equal(response.status, 201);
    const setup = (await response.json()).template;
    assert.equal(setup.configuration.image, image);
    assert.equal(setup.configuration.source_type, "image");

    const { createEnvironment, updateEnvironmentLifecycle, updateEnvironmentPreview } = await import("./workspace.js");
    const { createSnapshot, listSnapshots } = await import("./catalog.js");
    const auth = { user: { id: "user" }, session: { activeOrganizationId: "org" } } as import("./types.js").AuthSession;
    const captureApp = new Hono<import("./types.js").AppEnv>();
    captureApp.post("/environments", c => createEnvironment(c, auth));
    captureApp.put("/environments/:id/preview", c => updateEnvironmentPreview(c, auth));
    captureApp.put("/environments/:id/lifecycle", c => updateEnvironmentLifecycle(c, auth));
    captureApp.post("/snapshots", c => createSnapshot(c, auth));
    captureApp.get("/snapshots", c => listSnapshots(c, auth));
    async function request(path: string, body: unknown, method = "POST") {
      return captureApp.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    const sourceResponse = await request("/environments", { image: "ubuntu:24.04", startup_command: "npm run dev", readiness_command: "curl -f localhost:5173", workspace_path: "/workspaces/app", initialization_command: "npm run seed", preview_port: 5173, cpu: 4, memory_mb: 8192 });
    assert.equal(sourceResponse.status, 202, await sourceResponse.clone().text());
    const sourceId = (await sourceResponse.json()).id;
    // Simulate compute completion. This verifies persisted settings, not Docker capture.
    await admin.query("UPDATE compute_jobs SET status='succeeded' WHERE sandbox_id=$1", [sourceId]);
    await admin.query("UPDATE sandboxes SET state='running',runtime_id='qa-container' WHERE id=$1", [sourceId]);
    const liveCapture = await request("/snapshots", { environment_id: sourceId, name: "qa-live-capture" });
    assert.equal(liveCapture.status, 409);
    assert.match((await liveCapture.json()).error, /Stop the environment/);
    await admin.query("UPDATE sandboxes SET state='stopped',desired_state='stopped' WHERE id=$1", [sourceId]);
    const capture = await request("/snapshots", { environment_id: sourceId, name: "qa-capture" });
    assert.equal(capture.status, 202, await capture.clone().text());
    const snapshotId = (await capture.json()).id;
    const listed = (await (await captureApp.request("/snapshots")).json()).snapshots.find((snapshot: { id: string }) => snapshot.id === snapshotId);
    assert.equal(listed.launch_configuration.preview_port, 5173);
    assert.equal(listed.launch_configuration.initialization_command, undefined);
    assert.equal((await request("/environments", { source_type: "snapshot", snapshot_id: snapshotId })).status, 400);
    await admin.query("UPDATE workspace_snapshots SET status='ready',artifact_ref='s3://qa/snapshot' WHERE id=$1", [snapshotId]);
    await admin.query("UPDATE sandboxes SET startup_command='changed later',preview_port=8080 WHERE id=$1", [sourceId]);
    const restore = await request("/environments", { source_type: "snapshot", snapshot_id: snapshotId });
    assert.equal(restore.status, 202, await restore.clone().text());
    const restoredId = (await restore.json()).id;
    assert.notEqual(restoredId, sourceId);
    const restored = (await admin.query("SELECT startup_command,workspace_path,preview_port,cpu_count,memory_mb,repository,setup_command,initialization_command FROM sandboxes WHERE id=$1", [restoredId])).rows[0];
    assert.deepEqual(restored, { startup_command: "npm run dev", workspace_path: "/workspaces/app", preview_port: 5173, cpu_count: 4, memory_mb: 8192, repository: null, setup_command: null, initialization_command: null });
    const toggle = await request(`/environments/${restoredId}/preview`, { enabled: false }, "PUT");
    assert.deepEqual(await toggle.json(), { preview_enabled: false, preview_port: 5173 });
    assert.equal((await request(`/environments/${restoredId}/preview`, { enabled: true, preview_port: 65536 }, "PUT")).status, 400);
    const clear = await request(`/environments/${restoredId}/preview`, { enabled: true, preview_port: null }, "PUT");
    assert.deepEqual(await clear.json(), { preview_enabled: true, preview_port: null });
    const lifecycle = await request(`/environments/${restoredId}/lifecycle`, { auto_stop_minutes: 30 }, "PUT");
    assert.deepEqual(await lifecycle.json(), { auto_stop_minutes: 30 });
    assert.equal((await request(`/environments/${restoredId}/lifecycle`, { auto_stop_minutes: 0 }, "PUT")).status, 400);
    const disableLifecycle = await request(`/environments/${restoredId}/lifecycle`, { auto_stop_minutes: null }, "PUT");
    assert.deepEqual(await disableLifecycle.json(), { auto_stop_minutes: null });
    const apiRestore = await createEnvironmentForActor(actor, { source_type: "snapshot", snapshot_id: snapshotId, code_trust: "trusted", preview_port: 3000 });
    assert.equal((await admin.query("SELECT preview_port FROM sandboxes WHERE id=$1", [apiRestore.environment_id])).rows[0].preview_port, 3000);
    await assert.rejects(createEnvironmentForActor({ ...actor, organizationId: "other" }, { source_type: "snapshot", snapshot_id: snapshotId, code_trust: "trusted" }), /not ready or does not exist/);

  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
