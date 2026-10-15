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
const { upsertEnvironmentVariable, deleteEnvironmentVariable } = await import("./workspace.js");
const { decryptSecret, secretContext } = await import("./secrets.js");

test("variable storage enforces access, encrypts values, and preserves snapshot taint", async (t) => {
  let role = "admin";
  let trust = "trusted";
  let found = true;
  let active = false;
  let names: string[] = [];
  let queries: Array<{ sql: string; args: unknown[] }> = [];
  t.mock.method(db, "query", async () => ({ rows: [{ organization_id: "org", role }], rowCount: 1 }));
  t.mock.method(db, "connect", async () => ({
    query: async (sql: string, args: unknown[] = []) => {
      queries.push({ sql, args });
      if (sql.startsWith("SELECT code_trust")) return { rows: found ? [{ code_trust: trust }] : [], rowCount: found ? 1 : 0 };
      if (sql.includes("FROM compute_jobs")) return { rows: [], rowCount: active ? 1 : 0 };
      if (sql.startsWith("SELECT name")) return { rows: names.map(name => ({ name })), rowCount: names.length };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }));
  const context = (body: unknown) => ({
    req: { param: (key: string) => key === "id" ? "sandbox" : "TOKEN", json: async () => body },
    json: (body: unknown, status = 200) => ({ body, status }),
  }) as unknown as Parameters<typeof upsertEnvironmentVariable>[0];
  const session = { user: { id: "user" }, session: {} } as Parameters<typeof upsertEnvironmentVariable>[1];
  const save = () => upsertEnvironmentVariable(context({ name: "TOKEN", value: "secret-value" }), session);
  assert.equal((await save()).status, 200);
  const insert = queries.find(q => q.sql.startsWith("INSERT INTO sandbox_environment_variables"))!;
  assert.notEqual(insert.args[2], "secret-value");
  assert.equal(decryptSecret(insert.args[2] as string, insert.args[3] as string, secretContext.environment("org", "sandbox", "TOKEN")), "secret-value");
  assert.ok(queries.some(q => q.sql.includes("has_ever_received_environment_secrets = true")));
  queries = [];
  assert.equal((await deleteEnvironmentVariable(context({}), session)).status, 200);
  assert.ok(queries.some(q => q.sql.startsWith("DELETE FROM sandbox_environment_variables")));
  assert.ok(!queries.some(q => q.sql.includes("has_ever_received_environment_secrets")));
  names = Array.from({ length: 25 }, (_, i) => `VAR_${i}`);
  assert.equal((await save()).status, 400);
  names[0] = "TOKEN";
  assert.equal((await save()).status, 200);
  active = true;
  assert.equal((await save()).status, 409);
  active = false;
  trust = "untrusted";
  assert.equal((await save()).status, 403);
  found = false;
  assert.equal((await save()).status, 404);
  role = "member";
  assert.equal((await save()).status, 403);
  assert.equal((await deleteEnvironmentVariable(context({}), session)).status, 403);
});
