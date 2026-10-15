import type { PoolClient } from 'pg';

// Called inside the telemetry transaction. The environment lock serializes
// recovery against lifecycle requests; a queued start owns the actual restart.
export async function reportRuntimeProbe(client: PoolClient, nodeId: string, sandboxId: string, runtimeId: unknown, probe: unknown) {
  if (!['healthy', 'sysbox-failed', 'unavailable'].includes(String(probe)) || typeof runtimeId !== 'string' || !/^[a-f0-9]{12,64}$/.test(runtimeId)) return;
  const result = await client.query(`SELECT id, runtime_probe_failures,
      runtime_probe_at > now() - interval '10 seconds' AS too_soon,
      runtime_probe_at > now() - interval '2 minutes' AS recent,
      runtime_recovery_at > now() - interval '1 hour' AS exhausted
    FROM sandboxes WHERE id=$1 AND compute_node_id=$2 AND runtime_id LIKE $3 || '%'
      AND state='running' AND desired_state='running' AND purpose='development' FOR UPDATE`, [sandboxId, nodeId, runtimeId]);
  const environment = result.rows[0];
  if (!environment || environment.too_soon) return;
  const failures = probe === 'sysbox-failed' ? (environment.recent ? environment.runtime_probe_failures : 0) + 1 : 0;
  await client.query('UPDATE sandboxes SET runtime_probe_failures=$2, runtime_probe_at=now() WHERE id=$1', [sandboxId, failures]);
  if (probe === 'healthy') return;
  if ((await client.query(`SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')
      UNION ALL SELECT 1 FROM sandbox_executions WHERE sandbox_id=$1 AND status IN ('queued','running')
      UNION ALL SELECT 1 FROM agent_session_protections WHERE sandbox_id=$1 AND runtime_id LIKE $2 || '%' AND status IN ('launching','running') AND expires_at>now() AND lease_expires_at>now()`, [sandboxId,runtimeId])).rowCount) return;
  if (failures < 3) return;
  if (environment.exhausted) {
    await client.query("UPDATE sandboxes SET state='degraded', error_message='Environment command execution failed again after recovery. Administrator action required.' WHERE id=$1", [sandboxId]);
    return;
  }
  const jobId = `recovery_${crypto.randomUUID()}`;
  await client.query(`UPDATE sandboxes SET state='provisioning', provisioning_step='connecting',
    runtime_recovery_at=now(), error_message=NULL WHERE id=$1`, [sandboxId]);
  await client.query(`INSERT INTO compute_jobs (id,sandbox_id,operation,status,provisioning_step)
    VALUES ($1,$2,'start','queued','connecting')`, [jobId,sandboxId]);
  await client.query(`INSERT INTO sandbox_logs (sandbox_id,event_hash,recorded_at,severity,message)
    VALUES ($1,$2,now(),'error','Command execution failed repeatedly. Queued one environment restart to restore access.')`, [sandboxId,jobId]);
}
