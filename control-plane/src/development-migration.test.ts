import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import pg from "pg";

test("development migration preserves populated environments and permits legacy inserts", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await client.connect();
  const schema = `qa_development_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await client.query("CREATE TABLE organizations (id text PRIMARY KEY); CREATE TABLE sandboxes (id text PRIMARY KEY, name text); INSERT INTO organizations VALUES ('org'); INSERT INTO sandboxes VALUES ('existing', 'Keep me')");
    await client.query(await readFile(new URL("../migrations/0021_development_templates.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../migrations/0023_project_readiness.sql", import.meta.url), "utf8"));
    const row = (await client.query("SELECT * FROM sandboxes WHERE id = 'existing'")).rows[0];
    assert.equal(row.name, "Keep me"); assert.equal(row.repository, null); assert.equal(row.setup_command, null); assert.equal(row.startup_command, null); assert.equal(row.readiness_command, null);
    await client.query("INSERT INTO sandboxes (id, name) VALUES ('legacy', 'Old client')");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM sandboxes")).rows[0].count, 2);
  } finally { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); }
});
