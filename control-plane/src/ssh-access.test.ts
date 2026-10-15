import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

Object.assign(process.env, { DATABASE_URL: "postgres://test:test@localhost:5432/test", BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-better-auth-secret-000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  PREVIEW_TOKEN_SECRET: "test-preview-secret-0000000000000", TERMINAL_TOKEN_SECRET: "test-terminal-secret-000000000000",
  SSH_TOKEN_SECRET: "test-ssh-secret-000000000000000000", COMPUTE_AGENT_TOKEN: "test-compute-secret-0000000000000" });
const { db } = await import("./db.js");
const { updateEnvironmentSsh } = await import("./workspace.js");
const { registerComputeRoutes } = await import("./compute.js");

test("SSH toggle requires admin access, validates booleans, and scopes updates to the organization", async t => {
  let role = "admin";
  let found = true;
  const writes: unknown[][] = [];
  t.mock.method(db, "query", async (sql: string, args: unknown[]) => {
    if (sql.includes("FROM memberships")) return { rows: [{ organization_id: "org", role }] };
    assert.match(sql, /organization_id=\$3/);
    writes.push(args);
    return { rows: found ? [{ ssh_enabled: args[0] }] : [], rowCount: found ? 1 : 0 };
  });
  const app = new Hono();
  app.put("/:id", c => updateEnvironmentSsh(c as never, { user: { id: "user" }, session: {} } as never));
  const put = (enabled: unknown) => app.request("/env", { method: "PUT", body: JSON.stringify({ enabled }), headers: { "Content-Type": "application/json" } });
  assert.equal((await put(false)).status, 200);
  assert.deepEqual(writes[0], [false, "env", "org"]);
  assert.equal((await put("false")).status, 400);
  role = "member";
  assert.equal((await put(false)).status, 403);
  role = "admin"; found = false;
  assert.equal((await put(true)).status, 404);
});

test("gateway rejects disabled SSH before issuing a ticket", async t => {
  t.mock.method(db, "query", async (sql: string, params: unknown[]) => {
    assert.match(sql, /sandboxes.ssh_enabled/);
    assert.deepEqual(params, [null, "dev", `SHA256:${"a".repeat(43)}`]);
    return { rows: [], rowCount: 0 };
  });
  const app = new Hono<any>();
  registerComputeRoutes(app);
  const response = await app.request("/api/gateway/ssh/authorize", { method: "POST", headers: { authorization: `Bearer ${process.env.SSH_TOKEN_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ target: "dev", fingerprint: `SHA256:${"a".repeat(43)}` }) });
  assert.equal(response.status, 403);
});

test("gateway asks for an organization when an SSH key matches duplicate environment names", async t => {
  t.mock.method(db, "query", async () => ({ rows: [
    { sandbox_id: "env-a", compute_node_id: "node", user_id: "user" },
    { sandbox_id: "env-b", compute_node_id: "node", user_id: "user" },
  ], rowCount: 2 }));
  const app = new Hono<any>();
  registerComputeRoutes(app);
  const response = await app.request("/api/gateway/ssh/authorize", { method: "POST", headers: { authorization: `Bearer ${process.env.SSH_TOKEN_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ target: "dev", fingerprint: `SHA256:${"a".repeat(43)}` }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /organization\.dev/);
});
