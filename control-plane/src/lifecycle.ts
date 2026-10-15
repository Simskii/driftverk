import type { PoolClient } from "pg";
import { db } from "./db.js";

export async function queueEnvironmentWake(sandboxId: string, nodeId?: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sandbox = await client.query<{ runtime_id: string | null; state: string; desired_state: string; compute_node_id: string | null; development_pending: boolean; manual_stop: boolean }>(
      `SELECT runtime_id, state, desired_state, compute_node_id, manual_stop,
       ((repository IS NOT NULL OR setup_command IS NOT NULL OR initialization_command IS NOT NULL OR startup_command IS NOT NULL OR readiness_command IS NOT NULL OR prebuild_id IS NOT NULL) AND NOT EXISTS
         (SELECT 1 FROM compute_jobs WHERE sandbox_id = sandboxes.id AND operation = 'create' AND status = 'succeeded')) AS development_pending
       FROM sandboxes WHERE id = $1 AND purpose = 'development' FOR UPDATE`,
      [sandboxId],
    );
    if (!sandbox.rows[0] || sandbox.rows[0].state === "deleted" || sandbox.rows[0].desired_state === "deleted" || (nodeId && sandbox.rows[0].compute_node_id !== nodeId)) {
      await client.query("ROLLBACK");
      return { status: "unavailable" as const };
    }
    if (sandbox.rows[0].manual_stop) {
      await client.query("COMMIT");
      return { status: "stopped" as const };
    }
    if (sandbox.rows[0].state === "running" && sandbox.rows[0].desired_state === "running" && sandbox.rows[0].runtime_id) {
      await client.query("UPDATE sandboxes SET last_activity_at = now() WHERE id = $1", [sandboxId]);
      await client.query("COMMIT");
      return { status: "running" as const };
    }
    // The sandbox lock serializes wake decisions; locking jobs here would invert the agent lock order.
    const active = await client.query<{ id: string; operation: string }>(
      "SELECT id, operation FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued', 'leased')",
      [sandboxId],
    );
    const existing = active.rows.find((job) => job.operation === "start" || job.operation === "create");
    if (existing) {
      await client.query("COMMIT");
      return { status: "starting" as const, operation_id: existing.id };
    }
    if (active.rows.some(job => job.operation === "stop")) {
      await client.query("UPDATE sandboxes SET last_activity_at = now() WHERE id = $1", [sandboxId]);
    }
    if (active.rows[0]?.operation === "stop" || active.rows[0]?.operation === "snapshot") {
      await client.query("COMMIT");
      return { status: "starting" as const, operation_id: active.rows[0].id };
    }
    // Access must not undo deletion or continually retry a failed start.
    if (active.rows[0] || sandbox.rows[0].state === "degraded") {
      await client.query("COMMIT");
      return { status: "unavailable" as const };
    }
    const operation = sandbox.rows[0].runtime_id && !sandbox.rows[0].development_pending ? "start" : "create";
    const jobId = `job_${crypto.randomUUID()}`;
    await client.query(
      `UPDATE sandboxes SET desired_state = 'running', state = 'provisioning',
       provisioning_step = 'allocating', error_message = NULL, last_activity_at = now(), updated_at = now()
       WHERE id = $1`,
      [sandboxId],
    );
    await client.query(
      `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step)
       VALUES ($1, $2, $3, 'queued', 'allocating')`,
      [jobId, sandboxId, operation],
    );
    await client.query(
      `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
       VALUES ($1, $2, now(), 'info', 'Environment queued to start on access.')`,
      [sandboxId, `${jobId}:wake-on-access`],
    );
    await client.query("COMMIT");
    return { status: "starting" as const, operation_id: jobId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(100, limit));
}

export async function reconcileAutoStop(limit = 50): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string }>(
      `WITH candidates AS (
         SELECT sandboxes.id FROM sandboxes
         WHERE sandboxes.state = 'running' AND NOT EXISTS (SELECT 1 FROM sandbox_executions WHERE sandbox_id = sandboxes.id AND status IN ('queued','running'))
           AND NOT EXISTS (SELECT 1 FROM agent_session_protections p WHERE p.sandbox_id=sandboxes.id AND p.runtime_id=sandboxes.runtime_id AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now())
           AND sandboxes.desired_state = 'running'
           AND sandboxes.runtime_id IS NOT NULL
           AND sandboxes.auto_stop_minutes IS NOT NULL
           AND GREATEST(sandboxes.last_activity_at, COALESCE((SELECT LEAST(p.expires_at,p.lease_expires_at) FROM agent_session_protections p WHERE p.sandbox_id=sandboxes.id AND p.runtime_id=sandboxes.runtime_id),sandboxes.last_activity_at)) + sandboxes.auto_stop_minutes * interval '1 minute' <= now()
           AND NOT EXISTS (
             SELECT 1 FROM compute_jobs
             WHERE compute_jobs.sandbox_id = sandboxes.id AND compute_jobs.status IN ('queued', 'leased')
           )
         ORDER BY sandboxes.last_activity_at ASC
         FOR UPDATE OF sandboxes SKIP LOCKED
         LIMIT $1
       )
       UPDATE sandboxes
       SET desired_state = 'stopped', state = 'provisioning',
           provisioning_step = 'allocating', error_message = NULL, updated_at = now()
       FROM candidates
       WHERE sandboxes.id = candidates.id
       RETURNING sandboxes.id`,
      [boundedLimit(limit)],
    );
    for (const environment of expired.rows) {
      const jobId = `job_${crypto.randomUUID()}`;
      await client.query(
        `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step, auto_stop)
         VALUES ($1, $2, 'stop', 'queued', 'allocating', true)`,
        [jobId, environment.id],
      );
      await client.query(
        `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
         VALUES ($1, $2, now(), 'info', 'Environment queued for automatic stop after inactivity.')`,
        [environment.id, `${jobId}:auto-stop`],
      );
    }
    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileAutoDelete(limit = 50): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string }>(
      `SELECT sandboxes.id FROM sandboxes
       WHERE sandboxes.state <> 'deleted' AND NOT EXISTS (SELECT 1 FROM sandbox_executions WHERE sandbox_id = sandboxes.id AND status IN ('queued','running'))
           AND NOT EXISTS (SELECT 1 FROM agent_session_protections p WHERE p.sandbox_id=sandboxes.id AND p.runtime_id=sandboxes.runtime_id AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now())
         AND sandboxes.auto_delete_minutes IS NOT NULL
         AND sandboxes.created_at + sandboxes.auto_delete_minutes * interval '1 minute' <= now()
         AND NOT EXISTS (
           SELECT 1 FROM compute_jobs
           WHERE compute_jobs.sandbox_id = sandboxes.id AND compute_jobs.status IN ('queued', 'leased')
         )
       ORDER BY sandboxes.created_at ASC
       FOR UPDATE OF sandboxes SKIP LOCKED
       LIMIT $1`,
      [boundedLimit(limit)],
    );
    for (const environment of expired.rows) {
      const jobId = `job_${crypto.randomUUID()}`;
      await client.query(
        `UPDATE sandboxes SET desired_state = 'deleted', state = 'provisioning',
         provisioning_step = 'allocating', error_message = NULL, updated_at = now()
         WHERE id = $1`,
        [environment.id],
      );
      await client.query(
        `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step, auto_delete)
         VALUES ($1, $2, 'delete', 'queued', 'allocating', true)`,
        [jobId, environment.id],
      );
      await client.query(
        `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
         VALUES ($1, $2, now(), 'info', 'Environment queued for automatic deletion.')`,
        [environment.id, `${jobId}:auto-delete`],
      );
    }
    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Called by the owning agent immediately before docker stop. The caller locks the job.
// Once stopping is committed, access waits for stop/wake rather than cancelling a retry.
export async function authorizeEnvironmentStop(client: PoolClient, jobId: string, sandboxId: string): Promise<boolean> {
  await client.query("SELECT id FROM sandboxes WHERE id = $1 FOR UPDATE", [sandboxId]);
  const result = await client.query<{ cancel: boolean }>(
    `SELECT (j.provisioning_step <> 'stopping' AND j.auto_stop AND (s.auto_stop_minutes IS NULL OR
       s.last_activity_at + s.auto_stop_minutes * interval '1 minute' > now() OR
       EXISTS (SELECT 1 FROM sandbox_executions WHERE sandbox_id = s.id AND status IN ('queued','running')) OR
       EXISTS (SELECT 1 FROM agent_session_protections p WHERE p.sandbox_id=s.id AND p.runtime_id=s.runtime_id AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now()))) AS cancel
     FROM compute_jobs j JOIN sandboxes s ON s.id = j.sandbox_id WHERE j.id = $1 AND s.id = $2`,
    [jobId, sandboxId],
  );
  if (!result.rows[0]) throw new Error("Stop job not found");
  if (result.rows[0].cancel) {
    await client.query("UPDATE compute_jobs SET status = 'succeeded', provisioning_step = 'ready', lease_expires_at = NULL, updated_at = now() WHERE id = $1", [jobId]);
    await client.query("UPDATE sandboxes SET state = 'running', desired_state = 'running', provisioning_step = 'ready', updated_at = now() WHERE id = $1", [sandboxId]);
    await client.query(`INSERT INTO sandbox_logs (sandbox_id,event_hash,recorded_at,severity,message)
      VALUES ($1,$2,now(),'info','Automatic stop cancelled because the environment is active or auto-stop is disabled.')`, [sandboxId, `${jobId}:auto-stop-cancelled`]);
    return false;
  }
  await client.query("UPDATE compute_jobs SET provisioning_step = 'stopping', updated_at = now() WHERE id = $1", [jobId]);
  return true;
}

// The owning job is locked by the caller. A late host report can rescue work
// before deletion commits, but must never override a user's explicit delete.
export async function authorizeEnvironmentDelete(client: PoolClient, jobId: string, sandboxId: string): Promise<boolean> {
  await client.query('SELECT id FROM sandboxes WHERE id=$1 FOR UPDATE',[sandboxId]);
  const row=(await client.query(`SELECT (j.auto_delete AND j.provisioning_step<>'deleting' AND (
    EXISTS(SELECT 1 FROM sandbox_executions WHERE sandbox_id=s.id AND status IN ('queued','running')) OR
    EXISTS(SELECT 1 FROM agent_session_protections p WHERE p.sandbox_id=s.id AND p.runtime_id=s.runtime_id
      AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now()))) AS cancel
    FROM compute_jobs j JOIN sandboxes s ON s.id=j.sandbox_id WHERE j.id=$1 AND s.id=$2`,[jobId,sandboxId])).rows[0];
  if(!row)throw new Error('Delete job not found');
  if(row.cancel){
    await client.query("UPDATE compute_jobs SET status='succeeded',provisioning_step='ready',lease_expires_at=NULL,updated_at=now() WHERE id=$1",[jobId]);
    await client.query("UPDATE sandboxes SET state='running',desired_state='running',provisioning_step='ready',last_activity_at=now(),updated_at=now() WHERE id=$1",[sandboxId]);
    await client.query(`INSERT INTO sandbox_logs(sandbox_id,event_hash,recorded_at,severity,message)
      VALUES($1,$2,now(),'info','Automatic deletion cancelled because protected work is active.')`,[sandboxId,`${jobId}:auto-delete-cancelled`]);
    return false;
  }
  await client.query("UPDATE compute_jobs SET provisioning_step='deleting',updated_at=now() WHERE id=$1",[jobId]);
  return true;
}
