import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { AppEnv } from './types.js';

test('autostop protects executions, cancels on access, and commits shutdown once', {
  skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL,
}, async () => {
  const schema = `autostop_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const connection = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  connection.searchParams.set('options', `-csearch_path=${schema}`);
  process.env.DATABASE_URL = connection.href;
  process.env.BETTER_AUTH_URL = 'http://localhost:3000';
  process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-000000000';
  process.env.SECRET_ENCRYPTION_KEYS = 'test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  process.env.PREVIEW_TOKEN_SECRET = 'test-preview-secret-0000000000000';
  process.env.TERMINAL_TOKEN_SECRET = 'test-terminal-secret-000000000000';
  process.env.SSH_TOKEN_SECRET = 'test-ssh-secret-000000000000000000';
  process.env.COMPUTE_AGENT_TOKEN = 'test-compute-secret-0000000000000';
  process.env.MANAGED_COMPUTE_NODE_ID = 'node-a';
  const { db } = await import('./db.js');
  const { reconcileAutoStop, reconcileAutoDelete, authorizeEnvironmentDelete, authorizeEnvironmentStop, queueEnvironmentWake } = await import('./lifecycle.js');
  const { registerComputeRoutes } = await import('./compute.js');
  const app = new Hono<AppEnv>();
  registerComputeRoutes(app);
  const post = (path: string, body: object) => app.request(`/api/compute/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.COMPUTE_AGENT_TOKEN}` }, body: JSON.stringify({node_id:'node-a', ...body}) });
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE sandboxes (manual_stop boolean NOT NULL DEFAULT false, id text PRIMARY KEY, state text, desired_state text, runtime_id text,
        organization_id text DEFAULT 'org', created_at timestamptz DEFAULT now(), auto_delete_minutes int, auto_stop_minutes int, last_activity_at timestamptz, updated_at timestamptz,
        provisioning_step text, error_message text, purpose text DEFAULT 'development',
        billing_compute_active boolean DEFAULT false, compute_node_id text DEFAULT 'node-a', repository text, setup_command text, initialization_command text,
        startup_command text, readiness_command text, prebuild_id text);
      CREATE TABLE compute_jobs (id text PRIMARY KEY, sandbox_id text, operation text, status text,
        lease_owner text, snapshot_id text, provisioning_step text, lease_expires_at timestamptz, updated_at timestamptz);
      CREATE TABLE sandbox_metrics (recorded_at timestamptz);
      CREATE TABLE sandbox_executions (sandbox_id text, status text);
      CREATE TABLE sandbox_logs (sandbox_id text, event_hash text UNIQUE, recorded_at timestamptz, severity text, message text);
    `);
    await db.query(await readFile(new URL("../migrations/0051_agent_session_protection.sql",import.meta.url),"utf8"));
    await db.query("INSERT INTO compute_jobs(id,sandbox_id,operation) VALUES ('old','env','stop'),('manual','env','stop'); INSERT INTO sandbox_logs(sandbox_id,event_hash) VALUES ('env','old:auto-stop')");
    await db.query(await readFile(new URL('../migrations/0030_autostop_jobs.sql',import.meta.url),'utf8'));
    assert.deepEqual((await db.query('SELECT id,auto_stop FROM compute_jobs ORDER BY id')).rows,[{id:'manual',auto_stop:false},{id:'old',auto_stop:true}]);
    async function reset(minutes: number | null = 15) {
      await db.query('TRUNCATE sandboxes,compute_jobs,sandbox_executions,sandbox_logs,agent_session_protections');
      await db.query(`INSERT INTO sandboxes(id,state,desired_state,runtime_id,auto_stop_minutes,last_activity_at)
        VALUES ('env','running','running','abcdef123456',$1,now()-interval '20 minutes')`, [minutes]);
    }
    async function stop() {
      const job = (await db.query('SELECT id FROM compute_jobs')).rows[0];
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM compute_jobs WHERE id=$1 FOR UPDATE', [job.id]);
        const decision = await authorizeEnvironmentStop(client,job.id,'env');
        await client.query('COMMIT');
        return decision;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    await reset();
    assert.equal((await post('telemetry',{samples:[{sandbox_id:'env',active:true}]})).status,200);
    assert.equal(await reconcileAutoStop(),1,'old-agent runtime activity must not extend idle time');
    assert.equal((await post('activity',{sandbox_id:'env',node_id:'other'})).status,403);
    assert.equal((await post('activity',{sandbox_id:'env'})).status,200,'session data updates activity while stop is pending');
    const jobId = (await db.query('SELECT id FROM compute_jobs')).rows[0].id;
    await db.query("UPDATE compute_jobs SET status='leased',lease_owner='other'");
    assert.equal((await post(`jobs/${jobId}/events`,{event:'stopping'})).status,409,'another owner cannot authorize stop');
    await db.query("UPDATE compute_jobs SET lease_owner='node-a'");
    assert.deepEqual(await (await post(`jobs/${jobId}/events`,{event:'stopping'})).json(),{ok:true,stop:false});
    assert.deepEqual(await (await post(`jobs/${jobId}/events`,{event:'stopping'})).json(),{ok:true,stop:false},'lost response can be retried');
    const {protectAgentSession}=await import('./agent-sessions.js');
    await reset();
    const protection=await protectAgentSession('env','abcdef123456','node-a','test-user');
    assert.deepEqual(await protectAgentSession('env','abcdef123456','node-a','test-user'),protection,'reconnect never extends deadline');
    await assert.rejects(protectAgentSession('env','abcdef123456','node-a','changed-account'),/different account/);
    await db.query("UPDATE sandboxes SET last_activity_at=now()-interval '20 minutes'");
    assert.equal(await reconcileAutoStop(),0,'detached agent session protects against auto-stop');
    await db.query("UPDATE sandboxes SET auto_delete_minutes=1,created_at=now()-interval '1 day'");
    assert.equal(await reconcileAutoDelete(),0,'agent protects automatic deletion too');
    const sessions=await (await post('agent-sessions/poll',{})).json();
    assert.equal(sessions.sessions.length,1);
    const sessionId=sessions.sessions[0].id;
    assert.equal((await post(`agent-sessions/${sessionId}/report`,{status:'running'})).status,200);
    await db.query("UPDATE sandboxes SET last_activity_at=now()-interval '20 minutes'");
    assert.equal((await post(`agent-sessions/${sessionId}/report`,{status:'ended'})).status,200);
    assert.equal(await reconcileAutoStop(),0,'normal idle countdown starts when work ends');
    assert.equal((await post(`agent-sessions/${sessionId}/report`,{status:'running'})).status,200);
    assert.equal((await db.query('SELECT status FROM agent_session_protections')).rows[0].status,'ended','late heartbeat cannot revive ended session');
    await db.query("UPDATE sandboxes SET last_activity_at=now()-interval '20 minutes'");

    await db.query("UPDATE agent_session_protections SET status='ended',lease_expires_at=now()-interval '20 minutes'");
    assert.equal(await reconcileAutoStop(),1,'ended agent releases protection');
    await assert.rejects(protectAgentSession('env','abcdef123456','node-a','test-user'),/Wait until/,'cannot launch during shutdown');
    await reset();
    await protectAgentSession('env','abcdef123456','node-a','test-user');
    await db.query("UPDATE sandboxes SET last_activity_at=now()-interval '20 minutes'; UPDATE agent_session_protections SET expires_at=now()-interval '20 minutes',lease_expires_at=now()-interval '20 minutes'");
    assert.equal(await reconcileAutoStop(),1,'expired or unreachable sessions cannot pin compute forever');
    for (const operation of ['stop','delete']) {
      await reset();
      await protectAgentSession('env','abcdef123456','node-a','test-user');
      await db.query("UPDATE sandboxes SET auto_delete_minutes=1,created_at=now()-interval '1 day',last_activity_at=now()-interval '20 minutes'; UPDATE agent_session_protections SET lease_expires_at=now()-interval '20 minutes'");
      assert.equal(await (operation==='stop'?reconcileAutoStop():reconcileAutoDelete()),1);
      const session=(await db.query('SELECT id FROM agent_session_protections')).rows[0];
      await post(`agent-sessions/${session.id}/report`,{status:'running'});
      const job=(await db.query('SELECT id FROM compute_jobs')).rows[0];
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM compute_jobs WHERE id=$1 FOR UPDATE',[job.id]);
        assert.equal(await (operation==='stop'?authorizeEnvironmentStop:authorizeEnvironmentDelete)(client,job.id,'env'),false,'recovered agent cancels automatic lifecycle before commitment');
        await client.query('COMMIT');
      } finally {client.release();}
      assert.equal((await db.query('SELECT status FROM agent_session_protections')).rows[0].status,'running');
    }
    await reset();
    await protectAgentSession('env','abcdef123456','node-a','test-user');
    await db.query("INSERT INTO compute_jobs(id,sandbox_id,operation,status,lease_owner,provisioning_step) VALUES('manual-delete','env','delete','leased','node-a','allocating')");
    assert.deepEqual(await (await post('jobs/manual-delete/events',{event:'deleting'})).json(),{ok:true,delete:true},'explicit deletion overrides protection');
    assert.deepEqual(await (await post('jobs/manual-delete/events',{event:'deleting'})).json(),{ok:true,delete:true},'committed deletion stays committed on retry');
    await reset(null);
    assert.equal(await reconcileAutoStop(),0,'disabled');
    await reset();
    await db.query("UPDATE sandboxes SET last_activity_at=now()");
    assert.equal(await reconcileAutoStop(),0,'recent access');
    for (const status of ['queued','running']) {
      await reset();
      await db.query('INSERT INTO sandbox_executions VALUES ($1,$2)',['env',status]);
      assert.equal(await reconcileAutoStop(),0,`${status} execution protects environment`);
    }
    await reset();
    const counts = await Promise.all([reconcileAutoStop(),reconcileAutoStop()]);
    assert.equal(counts.reduce((a,b)=>a+b,0),1,'concurrent workers queue only one stop');
    assert.equal(await stop(),true,'idle environment can stop');
    await db.query('UPDATE sandboxes SET last_activity_at=now()');
    assert.equal(await stop(),true,'access cannot undo already committed shutdown');
    await reset();
    assert.equal(await reconcileAutoStop(),1);
    assert.equal((await queueEnvironmentWake('env')).status,'starting');
    assert.equal(await stop(),false,'access racing a pending stop cancels it');
    const env = (await db.query('SELECT state,desired_state FROM sandboxes')).rows[0];
    assert.deepEqual(env,{state:'running',desired_state:'running'});
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sandbox_logs WHERE event_hash LIKE '%:auto-stop-cancelled'")).rows[0].n,1);
    for (const change of ["UPDATE sandboxes SET auto_stop_minutes=NULL", "INSERT INTO sandbox_executions VALUES ('env','running')"]) {
      await reset(); await reconcileAutoStop(); await db.query(change);
      assert.equal(await stop(),false,'final check protects changed policy or active execution');
    }
    await reset();
    await db.query("INSERT INTO compute_jobs(id,sandbox_id,operation,status,provisioning_step) VALUES ('manual','env','stop','leased','allocating'); UPDATE sandboxes SET last_activity_at=now()");
    assert.equal(await stop(),true,'manual stop is not cancelled by access');
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
