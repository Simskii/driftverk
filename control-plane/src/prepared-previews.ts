import type { PoolClient } from 'pg';
import type { Context } from 'hono';
import { db } from './db.js';
import { workspaceFor } from './workspace.js';
import { createEnvironmentForActor, changeEnvironmentStateForActor, EnvironmentServiceError, type EnvironmentActor } from './environment-service.js';
import type { AppEnv } from './types.js';

function unrestricted(actor: EnvironmentActor) {
  if (actor.automationIdPrefix) throw new EnvironmentServiceError(403, 'Prepared previews require a trusted organization key');
}
function validConfiguration(configuration: Record<string, unknown>) {
  if (configuration.source_type !== 'snapshot' || !configuration.snapshot_id || configuration.repository)
    throw new EnvironmentServiceError(400, 'Use a prepared snapshot blueprint without repository setup');
  if (!configuration.startup_command || !configuration.readiness_command)
    throw new EnvironmentServiceError(400, 'The blueprint needs startup and readiness commands');
}
async function template(actor: EnvironmentActor, id: string, client: PoolClient) {
  unrestricted(actor);
  const row = (await client.query('SELECT * FROM environment_templates WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.organizationId])).rows[0];
  if (!row) throw new EnvironmentServiceError(404, 'Blueprint not found');
  return row;
}
export async function preparedPreviewStatus(actor: EnvironmentActor, id: string) {
  unrestricted(actor);
  const row = (await db.query(`SELECT t.keep_preview_ready AS enabled,t.preview_pool_error AS error,s.id AS environment_id,s.state,s.runtime_id,
    s.application_status,s.application_status_at,s.error_message,
    EXISTS(SELECT 1 FROM compute_jobs j WHERE j.sandbox_id=s.id AND j.status IN ('queued','leased')) AS busy,
    EXISTS(SELECT 1 FROM compute_jobs j WHERE j.sandbox_id=s.id AND j.status='queued') AS queued
    FROM environment_templates t LEFT JOIN sandboxes s ON s.id=t.prepared_environment_id AND s.state<>'deleted'
    WHERE t.id=$1 AND t.organization_id=$2`, [id, actor.organizationId])).rows[0];
  if (!row) throw new EnvironmentServiceError(404, 'Blueprint not found');
  const status = !row.enabled ? 'off' : row.error || row.error_message || row.state === 'degraded' || row.application_status?.status === 'failed' ? 'failed'
    : row.state === 'stopped' && !row.busy && row.application_status?.status === 'ready' ? 'ready' : row.queued && !row.runtime_id ? 'waiting' : 'preparing';
  return { enabled: row.enabled, status, environment_id: row.environment_id, error: row.error || row.error_message || null };
}
export async function configurePreparedPreview(actor: EnvironmentActor, id: string, enabled: unknown, client: PoolClient) {
  if (typeof enabled !== 'boolean') throw new EnvironmentServiceError(400, 'enabled must be true or false');
  const row = await template(actor, id, client);
  if (enabled) validConfiguration(row.configuration);
  await client.query('UPDATE environment_templates SET keep_preview_ready=$2,preview_pool_error=NULL WHERE id=$1', [id, enabled]);
  return { enabled };
}
export async function deletePreparedSpare(actor: EnvironmentActor, id: string, client: PoolClient) {
  const row = await template(actor,id,client);
  if (!row.prepared_environment_id) return;
  const spare=(await client.query("SELECT state FROM sandboxes WHERE id=$1",[row.prepared_environment_id])).rows[0];
  if (spare && spare.state !== 'deleted') await changeEnvironmentStateForActor(actor,row.prepared_environment_id,'delete',client);
}
async function create(actor: EnvironmentActor, row: any, name: string, client: PoolClient) {
  validConfiguration(row.configuration);
  const result = await createEnvironmentForActor(actor, { ...row.configuration, name, code_trust: 'trusted',
    auto_stop_minutes: null, auto_delete_minutes: 1440, preview_enabled: true }, client);
  await client.query('UPDATE sandboxes SET preview_template_id=$2 WHERE id=$1', [result.environment_id, row.id]);
  return result;
}

// The template lock serializes claims and replenishment across API replicas.
export async function claimPreparedPreview(actor: EnvironmentActor, id: string, name: unknown, client: PoolClient) {
  if (typeof name !== 'string' || !/^gh-[0-9]+-pr-[1-9][0-9]*$/.test(name) || name.length > 63)
    throw new EnvironmentServiceError(400, 'Use a GitHub repository and PR identity');
  const row = await template(actor, id, client);
  validConfiguration(row.configuration);
  let env = (await client.query(`SELECT * FROM sandboxes WHERE preview_template_id=$1 AND preview_claim_key=$2 AND state<>'deleted' FOR UPDATE`, [id, name])).rows[0];
  if (env?.desired_state === 'deleted') throw new EnvironmentServiceError(409, 'The previous preview is finishing cleanup; retry shortly');
  let source = 'existing';
  if (!env && row.prepared_environment_id && JSON.stringify(row.prepared_configuration) === JSON.stringify(row.configuration)) {
    const spare = (await client.query(`SELECT * FROM sandboxes WHERE id=$1 AND organization_id=$2 AND preview_claim_key IS NULL
      AND ((desired_state='running' AND state IN ('running','provisioning')) OR (desired_state='stopped' AND state='stopped')) FOR UPDATE`, [row.prepared_environment_id, actor.organizationId])).rows[0];
    const activeWork = spare && ((await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id=$1 AND status IN ('queued','running')", [spare.id])).rowCount
      || (await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')", [spare.id])).rowCount);
    if (spare && spare.application_status?.status !== 'failed' && !activeWork) {
      env = spare; source = spare.state === 'provisioning' ? 'preparing' : 'prepared';
      await client.query('UPDATE environment_templates SET prepared_environment_id=NULL,prepared_configuration=NULL WHERE id=$1', [id]);
    }
  }
  let operationId: string | null = null;
  if (!env) {
    const result = await create(actor, row, name, client);
    env = { id: result.environment_id }; operationId = result.operation_id; source = 'cold';
  }
  // Renew lifetime without altering the environment's historical creation time.
  await client.query(`UPDATE sandboxes SET name=$2,preview_claim_key=$2,auto_stop_minutes=NULL,
    auto_delete_minutes=CEIL(EXTRACT(EPOCH FROM (now()-created_at))/60)::int+1440,last_activity_at=now() WHERE id=$1`, [env.id, name]);
  const active = (await client.query("SELECT id FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased') LIMIT 1", [env.id])).rows[0];
  if (active) operationId = active.id;
  else if (env.state === 'stopped' || env.state === 'degraded') operationId = (await changeEnvironmentStateForActor(actor, env.id, 'start', client)).operation_id;
  return { environment_id: env.id, operation_id: operationId, source };
}

export async function reconcilePreparedPreviews() {
  const rows = (await db.query(`SELECT t.id,t.organization_id,o.name,o.slug,m.user_id FROM environment_templates t
    JOIN organizations o ON o.id=t.organization_id
    JOIN LATERAL (SELECT user_id FROM memberships WHERE organization_id=t.organization_id AND role='admin' ORDER BY created_at LIMIT 1) m ON true
    WHERE t.keep_preview_ready OR t.prepared_environment_id IS NOT NULL ORDER BY t.id LIMIT 100`)).rows;
  for (const item of rows) {
    const actor: EnvironmentActor = { organizationId:item.organization_id, organizationName:item.name, organizationSlug:item.slug, actorUserId:item.user_id, automationIdPrefix:null };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const row = await template(actor, item.id, client);
      const spare = row.prepared_environment_id ? (await client.query('SELECT * FROM sandboxes WHERE id=$1 FOR UPDATE', [row.prepared_environment_id])).rows[0] : null;
      if (spare && spare.state !== 'deleted') {
        const activeJob = (await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')", [spare.id])).rowCount;
        if (!row.keep_preview_ready || JSON.stringify(row.prepared_configuration) !== JSON.stringify(row.configuration)) {
          if (!activeJob)
            await changeEnvironmentStateForActor(actor, spare.id, 'delete', client);
        } else if (!activeJob && spare.state === 'running' && spare.application_status?.status === 'ready') {
          await changeEnvironmentStateForActor(actor, spare.id, 'stop', client);
        }
        // A failed spare stays visible for recovery; never create a retry storm.
      } else if (row.keep_preview_ready && !row.preview_pool_error) {
        const result = await create(actor, row, `ready-${crypto.randomUUID().slice(0, 12)}`, client);
        await client.query('UPDATE environment_templates SET prepared_environment_id=$2,prepared_configuration=configuration WHERE id=$1', [item.id, result.environment_id]);
      } else if (spare?.state === 'deleted' || row.prepared_environment_id) {
        await client.query('UPDATE environment_templates SET prepared_environment_id=NULL,prepared_configuration=NULL WHERE id=$1', [item.id]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await db.query('UPDATE environment_templates SET preview_pool_error=$2 WHERE id=$1', [item.id, error instanceof Error ? error.message : 'Could not prepare preview']);
    } finally { client.release(); }
  }
}

export async function preparedPreviewSettings(c: Context<AppEnv>) {
  const session = c.get('authSession');
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== 'admin') return c.json({error:'Admin access required'},403);
  const actor: EnvironmentActor = { organizationId:workspace.organization_id, organizationName:workspace.organization_name, organizationSlug:workspace.organization_slug, actorUserId:session.user.id, automationIdPrefix:null };
  try {
    if (c.req.method === 'GET') return c.json({ ...await preparedPreviewStatus(actor, c.req.param('id')!), can_manage:workspace.role === 'admin' });
    if (workspace.role !== 'admin') return c.json({error:'Admin access required'},403);
    const input = await c.req.json();
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await configurePreparedPreview(actor, c.req.param('id')!, input.enabled, client); await client.query('COMMIT'); return c.json(result); }
    catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch(error) { return c.json({error:error instanceof Error ? error.message : 'Could not update prepared preview'}, error instanceof EnvironmentServiceError ? error.status as 400 : 400); }
}
