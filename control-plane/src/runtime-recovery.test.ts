import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { reportRuntimeProbe } from './runtime-recovery.js';

test('runtime recovery requires consecutive failures, correct owner, no active work and a persistent budget', {
  skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL,
}, async () => {
  const pool = new pg.Pool({connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE sandboxes (id text,compute_node_id text,runtime_id text,state text,
      desired_state text,purpose text,provisioning_step text,error_message text);
      CREATE TEMP TABLE compute_jobs (id text,sandbox_id text,operation text,status text,provisioning_step text);
      CREATE TEMP TABLE agent_session_protections (sandbox_id text,runtime_id text,status text,expires_at timestamptz,lease_expires_at timestamptz);
      CREATE TEMP TABLE sandbox_executions (sandbox_id text,status text);
      CREATE TEMP TABLE sandbox_logs (sandbox_id text,event_hash text,recorded_at timestamptz,severity text,message text);`);
    await client.query(await readFile(new URL('../migrations/0044_runtime_recovery.sql', import.meta.url), 'utf8'));
    await client.query("INSERT INTO sandboxes (id,compute_node_id,runtime_id,state,desired_state,purpose) VALUES ('env','node','abcdef123456','running','running','development')");
    const count = async () => Number((await client.query('SELECT count(*) FROM compute_jobs')).rows[0].count);
    const probe = async (status = 'sysbox-failed', node = 'node') => {
      await client.query("UPDATE sandboxes SET runtime_probe_at=now()-interval '15 seconds'");
      await reportRuntimeProbe(client, node, 'env', 'abcdef123456', status);
    };
    await probe('sysbox-failed', 'other-node');
    assert.equal((await client.query('SELECT runtime_probe_failures FROM sandboxes')).rows[0].runtime_probe_failures, 0);
    await probe(); await probe();
    assert.equal(await count(), 0);
    await probe('healthy');
    await probe(); await probe();
    assert.equal(await count(), 0, 'healthy probe resets the streak');
    await client.query("INSERT INTO sandbox_executions VALUES ('env','running')");
    await probe();
    assert.equal(await count(), 0, 'active execution prevents restart');
    await client.query('DELETE FROM sandbox_executions');
    await client.query("INSERT INTO agent_session_protections VALUES('env','abcdef123456','running',now()+interval '1 hour',now()+interval '90 seconds')");
    await probe();
    assert.equal(await count(),0,'protected agent prevents a disruptive recovery restart');
    await client.query('DELETE FROM agent_session_protections');
    await probe();
    assert.equal(await count(), 1);
    assert.equal((await client.query('SELECT state FROM sandboxes')).rows[0].state, 'provisioning');
    await probe();
    assert.equal(await count(), 1, 'pending recovery cannot be duplicated');
    await client.query("DELETE FROM compute_jobs; UPDATE sandboxes SET state='running'");
    await probe();
    assert.equal(await count(), 0, 'budget survives a successful recovery');
    assert.equal((await client.query('SELECT state FROM sandboxes')).rows[0].state, 'degraded');
    await client.query("UPDATE sandboxes SET state='stopped',desired_state='stopped',runtime_recovery_at=NULL");
    await probe();
    assert.equal(await count(), 0, 'stopped environments stay stopped');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
