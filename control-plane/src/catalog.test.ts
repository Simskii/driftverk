import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";

const { db } = await import("./db.js");
const { createSnapshot, deleteSnapshot } = await import("./catalog.js");

test("allows snapshot capture after an environment has received variables", async (t) => {
  const queries: string[] = [];
  t.mock.method(db, "query", async () => ({
    rows: [{ organization_id: "org", organization_name: "Test", organization_slug: "test", role: "admin" }],
    rowCount: 1,
  }));
  t.mock.method(db, "connect", async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM sandboxes")) return { rows: [{ source_image: "image:dev", state: "stopped", runtime_id: "container" }], rowCount: 1 };
      if (sql.includes("sandbox_executions") || sql.includes("FROM compute_jobs")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }));

  const context = {
    req: { json: async () => ({ environment_id: "sandbox", name: "dev-snapshot" }) },
    json: (body: unknown, status = 200) => ({ body, status }),
  } as unknown as Parameters<typeof createSnapshot>[0];
  const session = {
    user: { id: "user" },
    session: { activeOrganizationId: "org" },
  } as Parameters<typeof createSnapshot>[1];

  const response = await createSnapshot(context, session);
  assert.equal(response.status, 202);
  assert.ok(queries.some((query) => query.includes("INSERT INTO workspace_snapshots")));
});

test("deletes an unused organization snapshot", async (t) => {
  const queries: string[] = [];
  t.mock.method(db, "query", async () => ({
    rows: [{ organization_id: "org", organization_name: "Test", organization_slug: "test", role: "admin" }],
    rowCount: 1,
  }));
  t.mock.method(db, "connect", async () => ({
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.startsWith("SELECT 1 FROM workspace_snapshots")) assert.deepEqual(params, ["snap_private", "org"]);
      if (sql.includes("FROM compute_jobs")) assert.deepEqual(params, ["snap_private"]);
      if (sql.includes("FROM compute_jobs")) return { rows: [], rowCount: 0 };
      return { rows: [{}], rowCount: 1 };
    },
    release() {},
  }));

  const context = {
    req: { param: () => "snap_private" },
    json: (body: unknown, status = 200) => ({ body, status }),
  } as unknown as Parameters<typeof deleteSnapshot>[0];
  const session = {
    user: { id: "user" },
    session: { activeOrganizationId: "org" },
  } as Parameters<typeof deleteSnapshot>[1];

  const response = await deleteSnapshot(context, session);
  assert.equal(response.status, 200);
  assert.ok(queries.some((query) => query.includes("DELETE FROM project_prebuilds")));
  assert.ok(queries.some((query) => query.includes("DELETE FROM workspace_snapshots")));
  assert.ok(queries.includes("COMMIT"));
});

test("deletes a snapshot referenced by an existing environment or completed prebuild", async (t) => {
  const queries: string[] = [];
  t.mock.method(db, "query", async () => ({
    rows: [{ organization_id: "org", organization_name: "Test", organization_slug: "test", role: "admin" }],
    rowCount: 1,
  }));
  t.mock.method(db, "connect", async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM compute_jobs")) return { rows: [], rowCount: 0 };
      return { rows: [{}], rowCount: 1 };
    },
    release() {},
  }));

  const context = {
    req: { param: () => "snap_used" },
    json: (body: unknown, status = 200) => ({ body, status }),
  } as unknown as Parameters<typeof deleteSnapshot>[0];
  const session = {
    user: { id: "user" },
    session: { activeOrganizationId: "org" },
  } as Parameters<typeof deleteSnapshot>[1];

  const response = await deleteSnapshot(context, session);
  assert.equal(response.status, 200);
  assert.ok(queries.some((query) => query.includes("SET prebuild_id = NULL")));
  assert.ok(queries.some((query) => query.includes("DELETE FROM project_prebuilds")));
  assert.ok(queries.some((query) => query.includes("DELETE FROM workspace_snapshots")));
  assert.ok(queries.includes("COMMIT"));
});

test("keeps a snapshot while it is used by an active operation", async (t) => {
  const queries: string[] = [];
  t.mock.method(db, "query", async () => ({
    rows: [{ organization_id: "org", organization_name: "Test", organization_slug: "test", role: "admin" }],
    rowCount: 1,
  }));
  t.mock.method(db, "connect", async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{}], rowCount: 1 };
    },
    release() {},
  }));

  const context = {
    req: { param: () => "snap_used" },
    json: (body: unknown, status = 200) => ({ body, status }),
  } as unknown as Parameters<typeof deleteSnapshot>[0];
  const session = {
    user: { id: "user" },
    session: { activeOrganizationId: "org" },
  } as Parameters<typeof deleteSnapshot>[1];

  const response = await deleteSnapshot(context, session);
  assert.equal(response.status, 409);
  assert.ok(!queries.some((query) => query.includes("DELETE FROM workspace_snapshots")));
  assert.ok(queries.includes("ROLLBACK"));
});
