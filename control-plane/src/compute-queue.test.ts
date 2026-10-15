import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { queueReasonSql } from "./resource-reservations.js";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";

const { claimJobSql } = await import("./compute.js");

// Opt in with a local test database. Only session-local temporary tables are used.
test("queue respects node ownership, tenant boundaries and expired leases", {
  skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL,
}, async () => {
  const client = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE organizations (id text PRIMARY KEY, hosting_mode text);
      CREATE TEMP TABLE compute_agents (id text, organization_id text, revoked_at timestamptz, last_seen_at timestamptz, cpu_count int, memory_mb int);
      CREATE TEMP TABLE sandboxes (id text PRIMARY KEY, organization_id text, compute_node_id text, snapshot_id text, repository text, purpose text DEFAULT 'development', prebuild_id text, initialization_command text, setup_command text, startup_command text, readiness_command text, source_image text, cpu_count int DEFAULT 2, memory_mb int DEFAULT 4096, state text DEFAULT 'provisioning', runtime_id text);
      CREATE TEMP TABLE workspace_snapshots (id text, source_sandbox_id text, artifact_ref text, storage_key text);
      CREATE TEMP TABLE workspace_volumes (id text, compute_node_id text);
      CREATE TEMP TABLE sandbox_volume_mounts (sandbox_id text, volume_id text);
      CREATE TEMP TABLE compute_jobs (
        id text PRIMARY KEY, sandbox_id text, operation text, status text,
        lease_owner text, snapshot_id text, runtime_class text DEFAULT 'container',
        lease_expires_at timestamptz, created_at timestamptz DEFAULT now()
      );
      INSERT INTO organizations VALUES ('cloud', 'managed'), ('customer-a', 'hybrid'), ('customer-b', 'hybrid');
    `);
    async function candidate(organization: string, node: string | null, status = "queued", expired = true) {
      await client.query("TRUNCATE pg_temp.compute_jobs, pg_temp.sandboxes");
      await client.query("INSERT INTO sandboxes (id, organization_id, compute_node_id) VALUES ('sandbox', $1, $2)", [organization, node]);
      await client.query(`INSERT INTO compute_jobs (id, sandbox_id, operation, status, lease_owner, lease_expires_at)
        VALUES ('job', 'sandbox', 'stop', $1, $2, now() + $3 * interval '1 minute')`, [status, node, expired ? -1 : 1]);
    }
    async function eligible(organization: string | null, node: string, operations: string[] | null = null) {
      return (await client.query(claimJobSql, [organization, node, operations, true, null, null, null, true, true])).rows.map(row => row.id);
    }
    await candidate("cloud", "node-a");
    await client.query("UPDATE compute_jobs SET operation = 'create'; UPDATE sandboxes SET repository = 'acme/app'");
    assert.deepEqual((await client.query(claimJobSql, [null, "node-a", null, false, null, null, null, true, true])).rows, [], "old agents cannot skip repository setup");
    assert.deepEqual(await eligible(null, "node-a"), ["job"]);
    await client.query("UPDATE sandboxes SET startup_command = 'npm run dev', readiness_command = 'true'");
    assert.equal((await client.query(claimJobSql, [null, "node-a", null, true, null, null, null, false, true])).rowCount, 0, "old agents cannot create projects without readiness support");
    await client.query("UPDATE compute_jobs SET operation = 'start'");
    assert.equal((await client.query(claimJobSql, [null, "node-a", null, true, null, null, null, false, true])).rowCount, 0, "resume also requires readiness support");
    assert.deepEqual(await eligible(null, "node-a"), ["job"]);
    await client.query("UPDATE compute_jobs SET operation = 'stop'");
    assert.equal((await client.query(claimJobSql, [null, "node-a", null, true, null, null, null, false, true])).rowCount, 1, "old agents can still stop projects");

    await candidate("cloud", "node-a");
    assert.deepEqual(await eligible(null, "node-b"), [], "another managed node must not stop this container");
    assert.deepEqual(await eligible(null, "node-a"), ["job"]);
    await candidate("cloud", null);
    assert.deepEqual(await eligible(null, "node-a"), ["job"], "new environments remain eligible");
    await candidate("cloud", "node-a", "leased");
    assert.deepEqual(await eligible(null, "node-b"), [], "expired leases stay on the owning node");
    assert.deepEqual(await eligible(null, "node-a"), ["job"]);
    await candidate("cloud", "node-a", "leased", false);
    assert.deepEqual(await eligible(null, "node-a"), [], "live leases must not be reclaimed");
    await candidate("customer-a", "node-a");
    assert.deepEqual(await eligible(null, "node-a"), [], "managed agents cannot claim hybrid jobs");
    assert.deepEqual(await eligible("customer-b", "node-a"), [], "hybrid agents cannot cross tenants");
    assert.deepEqual(await eligible("customer-a", "node-b"), [], "hybrid agents must use their owning node");
    assert.deepEqual(await eligible("customer-a", "node-a"), ["job"]);
    await candidate("customer-a", null);
    assert.deepEqual(await eligible("customer-a", "node-a"), ["job"]);
    await candidate("cloud", "node-a");
    assert.deepEqual(await eligible(null, "node-a", ["start"]), [], "resume worker must not take a slow stop job");
    assert.deepEqual(await eligible(null, "node-a", ["stop", "snapshot"]), ["job"]);
    await client.query("UPDATE compute_jobs SET operation = 'start'");
    assert.deepEqual(await eligible(null, "node-a", ["create", "stop", "delete", "snapshot"]), [], "general worker must not reclaim a resume lease");
    assert.deepEqual(await eligible(null, "node-a", ["start"]), ["job"]);
    await candidate("cloud", null);
    await client.query("INSERT INTO sandboxes (id, organization_id, compute_node_id) VALUES ('source', 'cloud', 'node-a')");
    await client.query("INSERT INTO workspace_snapshots VALUES ('snapshot', 'source', 'driftverk/snapshot-test:latest', NULL)");
    await client.query("UPDATE sandboxes SET snapshot_id = 'snapshot' WHERE id = 'sandbox'");
    await client.query("UPDATE compute_jobs SET operation = 'create'");
    assert.deepEqual(await eligible(null, "node-b"), [], "local snapshot must restore on its source host");
    assert.deepEqual(await eligible(null, "node-a"), ["job"]);
    await client.query("UPDATE workspace_snapshots SET artifact_ref = 's3://bucket/snapshot#sha256=example'");
    assert.deepEqual(await eligible(null, "node-b"), ["job"], "durable snapshots may restore on another host");
    await client.query("UPDATE sandboxes SET organization_id = 'customer-a'; UPDATE workspace_snapshots SET storage_key = 'shared-storage'");
    assert.deepEqual(await eligible("customer-a", "node-b"), [], "hybrid S3 restore requires compatible storage");
    assert.deepEqual((await client.query(claimJobSql, ["customer-a", "node-b", null, true, "different-storage", null, null, true, true])).rows, []);
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-b", null, true, "shared-storage", null, null, true, true])).rowCount, 1);
    await candidate("customer-a", null);
    await client.query("INSERT INTO workspace_volumes VALUES ('volume', 'node-a'); INSERT INTO sandbox_volume_mounts VALUES ('sandbox', 'volume')");
    assert.deepEqual(await eligible("customer-a", "node-b"), [], "a host must not create an empty replacement for another host's volume");
    assert.deepEqual(await eligible("customer-a", "node-a"), ["job"]);
    await client.query("UPDATE compute_jobs SET operation = 'create'");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 1, 8192, true, true])).rowCount, 1, "CPU limits can exceed host CPU while reservations fit");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 4, 2048, true, true])).rowCount, 0, "undersized RAM cannot claim a create");
    await client.query("INSERT INTO sandboxes (id, organization_id, compute_node_id, state) VALUES ('busy', 'customer-a', 'node-a', 'running')");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 2, 8192, true, true])).rowCount, 1, "two 2 CPU / 4 GB limits fit using smaller reservations");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 2, 4096, true, true])).rowCount, 0, "RAM reservations leave host headroom");
    await client.query("UPDATE sandboxes SET cpu_count=8 WHERE id='busy'");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 2, 8192, true, true])).rowCount, 0, "CPU reservations still prevent unlimited placement");
    await client.query("UPDATE sandboxes SET cpu_count=2 WHERE id='busy'");
    await client.query("INSERT INTO compute_agents VALUES ('node-a','customer-a',NULL,now(),2,4096)");
    const reason = async () => (await client.query(`SELECT ${queueReasonSql} AS reason FROM sandboxes WHERE id='sandbox'`)).rows[0].reason;
    assert.equal(await reason(), "insufficient_capacity", "queue message uses the same RAM reservations and headroom");
    await client.query("UPDATE compute_agents SET memory_mb=8192");
    assert.equal(await reason(), null, "message clears when reservations fit");
    await client.query("UPDATE sandboxes SET memory_mb=1024 WHERE id IN ('sandbox','busy')");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 2, 1024, true, true])).rowCount, 1, "two small containers reserve 256 MB each and leave 512 MB for the host");
    await client.query("UPDATE compute_agents SET memory_mb=768");
    assert.equal(await reason(), "insufficient_capacity");
    await client.query("UPDATE sandboxes SET compute_node_id='node-a' WHERE id='sandbox'");
    assert.equal(await reason(), "insufficient_capacity", "pinned environments also explain capacity waits");
    await client.query("UPDATE compute_agents SET last_seen_at=now()-interval '2 minutes'");
    assert.equal(await reason(), null, "offline hosts do not imply a capacity shortage");
    await client.query("UPDATE compute_agents SET last_seen_at=now(), memory_mb=NULL");
    assert.equal(await reason(), null, "unknown RAM follows scheduler compatibility rules");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 4, 8192, true, true])).rowCount, 1, "a host with room can claim");
    await client.query("UPDATE compute_jobs SET operation = 'stop'");
    assert.equal((await client.query(claimJobSql, ["customer-a", "node-a", null, true, null, 1, 1024, true, true])).rowCount, 1, "cleanup still works when capacity is exhausted");
    await candidate("cloud", "node-a", "succeeded");
    assert.deepEqual(await eligible(null, "node-a"), [], "completed jobs are not claimable");
  } finally {
    await client.end();
  }
});
