import type { Context } from 'hono';
import { db } from './db.js';
import { workspaceFor } from './workspace.js';
import { getExecution, executionOutput, executionArtifact, cancelExecution } from './executions.js';
import { EnvironmentServiceError } from './environment-service.js';
import type { AppEnv, AuthSession } from './types.js';

export async function environmentTasks(c: Context<AppEnv>, session: AuthSession) {
  const workspace=await workspaceFor(session.user,session.session.activeOrganizationId);
  const actor={organizationId:workspace.organization_id,organizationName:workspace.organization_name,
    organizationSlug:workspace.organization_slug,actorUserId:session.user.id,accessUserId:session.user.id,automationIdPrefix:null};
  const id=c.req.param('id')!;
  c.header('Cache-Control','no-store');
  try {
    const environment=await db.query('SELECT id FROM sandboxes WHERE id=$1 AND organization_id=$2 AND can_access_environment(id,$3)',[id,actor.organizationId,session.user.id]);
    if (!environment.rowCount) return c.json({error:'Environment not found'},404);
    const executionId=c.req.query('execution');
    if (!executionId) {
      if(c.req.method!=='GET') return c.json({error:'Choose an execution'},400);
      const rows=(await db.query(`SELECT id,command,cwd,status,exit_code,created_at,updated_at FROM sandbox_executions
        WHERE sandbox_id=$1 AND organization_id=$2 ORDER BY created_at DESC LIMIT 50`,[id,actor.organizationId])).rows;
      return c.json({executions:rows});
    }
    const execution=await getExecution(actor,executionId);
    if(execution.environment_id!==id) return c.json({error:'Execution not found'},404);
    if(c.req.method==='POST') return c.json(await cancelExecution(actor,executionId));
    const artifact=c.req.query('artifact');
    if(artifact) {
      const data=await executionArtifact(actor,executionId,artifact);
      const filename=(artifact.split('/').pop() || '').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120) || 'task-artifact';
      return new Response(new Uint8Array(data),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    return c.json({execution,output:await executionOutput(actor,executionId,c.req.query('after') || '0')});
  } catch(error) {
    if(error instanceof EnvironmentServiceError) return c.json({error:error.message},error.status as 400);
    throw error;
  }
}
