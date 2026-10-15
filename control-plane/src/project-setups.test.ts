import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";

test("project setup API, MCP and SDK share scoped, idempotent configuration management", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_setups_${crypto.randomUUID().replaceAll("-", "")}`;
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
    await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('user','User','setups@example.test',true);
      INSERT INTO organizations (id,name,slug,hosting_mode) VALUES ('org','Org','org','managed'), ('other','Other','other','managed');
      INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('admin-org','org','user','admin'),('admin-other','other','user','admin');
      UPDATE billing_accounts SET complimentary=true;`);
    const { Hono } = await import("hono");
    const { registerPublicApiRoutes } = await import("./public-api.js");
    const { handleMcp } = await import("./mcp.js");
    const app = new Hono<import("./types.js").AppEnv>();
    app.use("*", async (c, next) => { c.set("requestId", crypto.randomUUID()); await next(); });
    registerPublicApiRoutes(app);
    app.all("/mcp", handleMcp);
    const keys: Record<string, string> = {};
    for (const [name, org, scopes, prefix] of [
      ["full", "org", ["read", "write", "delete"], null],
      ["read", "org", ["read"], null],
      ["foreign", "other", ["read", "write", "delete"], null],
      ["scoped", "org", ["read", "write", "delete"], "github:123:pr:"],
    ] as const) {
      const id = `key_${crypto.randomUUID().replaceAll("-", "")}`, secret = "a".repeat(43);
      await admin.query("INSERT INTO api_keys (id,organization_id,name,secret_hash,secret_prefix,scopes,automation_id_prefix,created_by_user_id) VALUES ($1,$2,$3,$4,'local',$5,$6,'user')", [id, org, name, createHash("sha256").update(secret).digest("hex"), scopes, prefix]);
      keys[name] = `dvk_live_${id}.${secret}`;
    }
    const { Driftverk } = await import(new URL("../../sdk/index.mjs", import.meta.url).href);
    const sdk = new Driftverk({ baseUrl: "http://localhost:3098", apiKey: keys.full, fetch: (input: string, init: RequestInit) => app.request(input, init) });
    async function api(method: string, path: string, key = "full", body?: unknown, idempotencyKey: string = crypto.randomUUID()) {
      return app.request(`/v1${path}`, { method, headers: { authorization: `Bearer ${keys[key]}`, "content-type": "application/json", "Idempotency-Key": idempotencyKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function rpc(method: string, params: Record<string, unknown>, key = "full") {
      const response = await app.request("http://localhost:3098/mcp", { method: "POST", headers: {
        authorization: `Bearer ${keys[key]}`, host: "localhost:3098", "content-type": "application/json", accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
      } } }) });
      assert.equal(response.status, 200, await response.clone().text());
      const text = await response.text();
      return JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data:"))!.slice(5));
    }
    async function tool(name: string, args: unknown, key = "full") {
      return (await rpc("tools/call", { name, arguments: args }, key)).result;
    }
    const input = { name: "Project", configuration: { image: "driftverk-dev:1", setup_command: "npm ci", initialization_command: "npm run seed", cpu: 1, memory_mb: 1024, environment_variables: [{ name: "SECRET", value: "do-not-copy" }], volume_mounts: [{ volume_id: "private" }] } };
    const setup = await sdk.createProjectSetup(input, { idempotencyKey: "setup-create-test" });
    assert.equal((await sdk.createProjectSetup(input, { idempotencyKey: "setup-create-test" })).id, setup.id);
    assert.equal(JSON.stringify(setup).includes("do-not-copy"), false);
    assert.equal(setup.configuration.volume_mounts, undefined);
    assert.equal(setup.configuration.memory_mb, 1024);
    assert.equal((await sdk.getProjectSetup(setup.id)).name, "Project");
    assert.equal((await sdk.listProjectSetups()).length, 1);
    assert.equal((await api("POST", "/project-setups", "full", { ...input, name: "Changed" }, "setup-create-test")).status, 409);
    assert.equal((await api("POST", "/project-setups", "full", input)).status, 409, "duplicate names are conflicts");
    assert.equal((await api("POST", "/project-setups", "full", null)).status, 400);
    assert.equal((await api("POST", "/project-setups", "full", { name: "Missing registry", configuration: { image: "image:1", registry_id: "foreign" } })).status, 400);
    assert.equal((await api("POST", "/project-setups", "full", { name: "Missing snapshot", configuration: { source_type: "snapshot", snapshot_id: "foreign" } })).status, 400);
    for (const key of ["read", "scoped"]) {
      assert.equal((await api("POST", "/project-setups", key, input)).status, 403);
      assert.equal((await api("PUT", `/project-setups/${setup.id}`, key, input)).status, 403);
      assert.equal((await api("DELETE", `/project-setups/${setup.id}`, key)).status, 403);
    }
    assert.equal((await api("GET", "/project-setups", "scoped")).status, 403);
    for (const method of ["GET", "PUT", "DELETE"]) {
      assert.equal((await api(method, `/project-setups/${setup.id}`, "foreign", method === "PUT" ? input : undefined)).status, 404);
    }
    const build = await sdk.buildPrebuild({ template_id: setup.id });
    assert.equal((await sdk.getPrebuild(build.id)).status, "building");
    assert.equal((await api("GET", `/prebuilds/${build.id}`, "foreign")).status, 404);
    assert.equal((await api("GET", `/prebuilds/${build.id}`, "scoped")).status, 403);
    const replacement = { name: "Updated", configuration: { image: "driftverk-dev:1", setup_command: "npm ci --ignore-scripts" } };
    const updated = await sdk.updateProjectSetup(setup.id, replacement, { idempotencyKey: "setup-update-test" });
    assert.equal(updated.configuration.memory_mb, 2048, "PUT resets omitted settings");
    assert.equal(updated.configuration.initialization_command, null);
    assert.equal((await sdk.getPrebuild(build.id)).configuration.setup_command, "npm ci", "existing build retains original configuration");
    assert.equal((await sdk.updateProjectSetup(setup.id, replacement, { idempotencyKey: "setup-update-test" })).name, "Updated");

    const readTools = (await rpc("tools/list", {}, "read")).result.tools.map((value: { name: string }) => value.name);
    assert.ok(readTools.includes("list_project_setups") && readTools.includes("get_project_setup") && readTools.includes("get_prebuild"));
    for (const name of ["create_project_setup", "update_project_setup", "delete_project_setup", "create_preview"]) assert.ok(!readTools.includes(name));
    const fullTools = (await rpc("tools/list", {})).result.tools;
    const createEnvironment = fullTools.find((value: { name: string }) => value.name === "create_environment");
    assert.ok(createEnvironment.inputSchema.properties.auto_stop_minutes);
    assert.ok(createEnvironment.inputSchema.properties.auto_delete_minutes);
    const mcpInput = { name: "MCP project", configuration: { image: "driftverk-dev:1", memory_mb: 1024 }, idempotency_key: "mcp-setup-create" };
    const mcpCreated = await tool("create_project_setup", mcpInput);
    assert.ok(!mcpCreated.isError, JSON.stringify(mcpCreated));
    const mcpSetup = JSON.parse(mcpCreated.content[0].text).data;
    assert.equal(JSON.parse((await tool("create_project_setup", mcpInput)).content[0].text).data.id, mcpSetup.id);
    assert.equal((await tool("create_project_setup", { ...mcpInput, name: "Conflict" })).isError, true, "idempotency errors are MCP failures");
    assert.equal((await tool("create_project_setup", { ...mcpInput, idempotency_key: "mcp-scoped-test" }, "scoped")).isError, true);
    assert.equal((await tool("get_project_setup", { template_id: mcpSetup.id }, "foreign")).isError, true);
    assert.equal(JSON.parse((await tool("get_project_setup", { template_id: mcpSetup.id })).content[0].text).project_setup.id, mcpSetup.id);
    assert.equal(JSON.parse((await tool("get_prebuild", { prebuild_id: build.id })).content[0].text).prebuild.id, build.id);
    assert.ok(!((await tool("update_project_setup", { ...mcpInput, name: "MCP updated", template_id: mcpSetup.id, idempotency_key: "mcp-setup-update" })).isError));
    assert.equal((await sdk.getProjectSetup(mcpSetup.id)).name, "MCP updated");
    assert.ok(!((await tool("delete_project_setup", { template_id: mcpSetup.id, idempotency_key: "mcp-setup-delete" })).isError));
    assert.equal((await api("GET", `/project-setups/${mcpSetup.id}`)).status, 404);
    assert.equal((await tool("create_preview", { environment_id: "foreign", port: 3000 })).isError, true);
    assert.equal((await api("POST", "/environments/foreign/ports/3000/preview")).status, 404, "preview authorization errors retain API status");

    const environmentResult = await tool("create_environment", {
      image: `example/app@sha256:${"a".repeat(64)}`, code_trust: "trusted", memory_mb: 1024,
      auto_stop_minutes: null, auto_delete_minutes: 60, idempotency_key: "mcp-environment-create",
    });
    assert.ok(!environmentResult.isError, JSON.stringify(environmentResult));
    const environmentId = JSON.parse(environmentResult.content[0].text).data.environment_id;
    const environment = await sdk.getEnvironment(environmentId);
    assert.equal(environment.memory_mb, 1024);
    assert.equal(environment.auto_stop_minutes, null);
    assert.equal(environment.auto_delete_minutes, 60);
    // Simulate successful provisioning; this verifies grants, not a live gateway or container.
    await admin.query("UPDATE sandboxes SET state='running', runtime_id='local-fixture', compute_node_id='node-a' WHERE id=$1", [environmentId]);
    await admin.query("UPDATE compute_jobs SET status='succeeded' WHERE sandbox_id=$1", [environmentId]);
    const preview = await sdk.createPreview(environmentId, 3000);
    assert.ok(new URL(preview.url).searchParams.has("token"));
    assert.ok(Date.parse(preview.expires_at) > Date.now());
    assert.ok(!((await tool("create_preview", { environment_id: environmentId, port: 3000 })).isError));
    assert.equal((await tool("create_preview", { environment_id: environmentId, port: 3000 }, "foreign")).isError, true);
    assert.equal((await tool("create_preview", { environment_id: environmentId, port: 3000 }, "scoped")).isError, true);
    await admin.query("UPDATE sandboxes SET preview_enabled=false WHERE id=$1", [environmentId]);
    assert.equal((await tool("create_preview", { environment_id: environmentId, port: 3000 })).isError, true);

    await sdk.deleteProjectSetup(setup.id, { idempotencyKey: "setup-delete-test" });
    await sdk.deleteProjectSetup(setup.id, { idempotencyKey: "setup-delete-test" });
    assert.equal((await sdk.getPrebuild(build.id)).template_id, null, "deleting configuration retains the build");
    assert.equal((await api("GET", `/project-setups/${setup.id}`)).status, 404);
    assert.ok((await admin.query("SELECT 1 FROM api_audit_events WHERE action='project_setup.create'")).rowCount);
    assert.ok((await admin.query("SELECT 1 FROM api_audit_events WHERE action='project_setup.update'")).rowCount);
    assert.ok((await admin.query("SELECT 1 FROM api_audit_events WHERE action='project_setup.delete'")).rowCount);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
