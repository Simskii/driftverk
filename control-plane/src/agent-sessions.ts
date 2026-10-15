import type { Context } from 'hono';
import { db } from './db.js';
import type { AppEnv } from './types.js';

// One bounded session per environment. Reconnecting never extends its deadline.
export async function protectAgentSession(sandboxId: string, runtimeId: string, nodeId: string, identity: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const env = (await client.query(`SELECT id FROM sandboxes WHERE id=$1 AND runtime_id=$2 AND compute_node_id=$3
      AND state='running' AND desired_state='running' FOR UPDATE`, [sandboxId,runtimeId,nodeId])).rows[0];
    if (!env || (await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')",[sandboxId])).rowCount)
      throw new Error('Wait until the environment is ready with no lifecycle operation in progress');
    const previous = (await client.query(`SELECT *, expires_at > now() AS unexpired FROM agent_session_protections WHERE sandbox_id=$1`,[sandboxId])).rows[0];
    if (previous && previous.runtime_id === runtimeId && ['launching','running'].includes(previous.status) && previous.unexpired) {
      if (previous.identity !== identity) throw new Error('An agent session is already using a different account or configuration. Stop the environment before switching.');
      await client.query('COMMIT');
      return { socket: previous.socket as string, expires_at: new Date(previous.expires_at).toISOString() };
    }
    const id = crypto.randomUUID();
    const session = (await client.query(`INSERT INTO agent_session_protections(sandbox_id,id,runtime_id,socket,status,expires_at,lease_expires_at,identity)
      VALUES($1,$2,$3,$4,'launching',now()+interval '1 hour',now()+interval '90 seconds',$5)
      ON CONFLICT(sandbox_id) DO UPDATE SET id=excluded.id,runtime_id=excluded.runtime_id,socket=excluded.socket,
      identity=excluded.identity,status=excluded.status,expires_at=excluded.expires_at,lease_expires_at=excluded.lease_expires_at,created_at=now()
      RETURNING socket,expires_at`,[sandboxId,id,runtimeId,`driftverk-session-${id}`,identity])).rows[0];
    await client.query('UPDATE sandboxes SET last_activity_at=now() WHERE id=$1',[sandboxId]);
    await client.query('COMMIT');
    return { socket: session.socket as string, expires_at: new Date(session.expires_at).toISOString() };
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function pollAgentSessions(c: Context<AppEnv>) {
  const node = c.get('computeAgent');
  const sessions = (await db.query(`SELECT p.id,p.sandbox_id,p.runtime_id,p.socket,p.status,p.expires_at,p.created_at, s.runtime_id AS current_runtime_id, s.state AS environment_state
    FROM agent_session_protections p JOIN sandboxes s ON s.id=p.sandbox_id
    WHERE s.compute_node_id=$1 AND ($2::text IS NULL OR s.organization_id=$2)
      AND p.status IN ('launching','running')`,[node.id,node.organizationId])).rows;
  return c.json({ sessions });
}

export async function reportAgentSession(c: Context<AppEnv>) {
  const node = c.get('computeAgent');
  const input = await c.req.json().catch(()=>null);
  if (!input || !['running','ended','expired','lost'].includes(input.status)) return c.json({error:'Invalid session report'},400);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Always acquire the environment before its session, including lifecycle races.
    const env = (await client.query(`SELECT s.id,s.runtime_id FROM sandboxes s JOIN agent_session_protections p ON p.sandbox_id=s.id
      WHERE p.id=$1 AND s.compute_node_id=$2 AND ($3::text IS NULL OR s.organization_id=$3) FOR UPDATE OF s`,
      [c.req.param('id'),node.id,node.organizationId])).rows[0];
    if (!env) { await client.query('ROLLBACK'); return c.json({error:'Session not found'},404); }
    const changed = await client.query(`UPDATE agent_session_protections SET
      status=CASE WHEN runtime_id<>$3 THEN 'lost' WHEN expires_at<=now() THEN 'expired' ELSE $2 END,
      lease_expires_at=CASE WHEN $2='running' AND runtime_id=$3 AND expires_at>now() THEN LEAST(expires_at,now()+interval '90 seconds') ELSE now() END
      WHERE id=$1 AND status IN ('launching','running') RETURNING id`,[c.req.param('id'),input.status,env.runtime_id]);
    if (changed.rowCount) await client.query('UPDATE sandboxes SET last_activity_at=now() WHERE id=$1',[env.id]);
    await client.query('COMMIT');
    return c.json({ok:true});
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
