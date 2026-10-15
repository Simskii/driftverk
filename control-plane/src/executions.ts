import { encryptSecret, decryptSecret } from "./secrets.js";
import { parseTailscaleOutput, tailscaleCommand } from "./tailscale-command.js";
import type { PoolClient } from "pg";
import type { Context } from "hono";
import { db } from "./db.js";
import { EnvironmentServiceError, type EnvironmentActor } from "./environment-service.js";
import type { AppEnv } from "./types.js";

export const executionTerminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "output_limit", "lost"]);
export function parseExecutionEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 25) throw new EnvironmentServiceError(400, "Use at most 25 execution environment variables");
  const environment: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const variable of value) {
    if (!variable || typeof variable !== "object" || typeof variable.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable.name) || typeof variable.value !== "string" || variable.value.includes("\0") || variable.value.length > 32768 || Object.hasOwn(environment, variable.name))
      throw new EnvironmentServiceError(400, "Invalid or duplicate execution environment variable");
    bytes += Buffer.byteLength(variable.name) + Buffer.byteLength(variable.value);
    if (bytes > 65536) throw new EnvironmentServiceError(400, "Execution environment variables exceed 64 KiB");
    environment[variable.name] = variable.value;
  }
  return environment;
}

const executionSecretContext = (organizationId: string, executionId: string) => `organization:${organizationId}:execution:${executionId}:environment`;

export function parseExecution(input: Record<string, unknown>, workspace: string | null) {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : workspace || "/";
  const timeout = Number(input.timeout_seconds ?? 900);
  const artifacts = input.artifacts ?? [];
  if (!command || command.length > 8000 || command.includes("\0")) throw new EnvironmentServiceError(400, "Use a command of 1–8000 characters");
  if (!cwd.startsWith("/") || cwd.length > 1000 || cwd.includes("\0")) throw new EnvironmentServiceError(400, "cwd must be an absolute sandbox path");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new EnvironmentServiceError(400, "Timeout must be 1–3600 seconds");
  if (!Array.isArray(artifacts) || artifacts.length > 4 || new Set(artifacts).size !== artifacts.length || artifacts.some(path => typeof path !== "string" || path.length > 300 || !path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part: string) => !part || part === "." || part === "..")))
    throw new EnvironmentServiceError(400, "Use up to four unique artifact paths relative to cwd, without dot segments");
  return { command, cwd, timeout_seconds: timeout, artifact_paths: artifacts as string[] };
}

async function authorize(actor: EnvironmentActor, id: string, client: Pick<PoolClient, "query"> = db) {
  const row = (await client.query(`SELECT e.* FROM sandbox_executions e JOIN sandboxes s ON s.id = e.sandbox_id
    WHERE e.id = $1 AND e.organization_id = $2 AND ($3::text IS NULL OR s.automation_id LIKE $3 || '%') AND ($4::text IS NULL OR can_access_environment(s.id,$4))`, [id, actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null])).rows[0];
  if (!row) throw new EnvironmentServiceError(404, "Execution not found");
  return row;
}
export async function createExecution(actor: EnvironmentActor, environmentId: string, input: Record<string, unknown>, client: PoolClient) {
  // Workspace lock serializes admission across different sandboxes in one organization.
  await client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [actor.organizationId]);
  const env = (await client.query(`SELECT * FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development'
    AND ($3::text IS NULL OR automation_id LIKE $3 || '%') AND ($4::text IS NULL OR can_access_environment(id,$4)) FOR UPDATE`, [environmentId, actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null])).rows[0];
  if (!env) throw new EnvironmentServiceError(404, "Environment not found");
  if (env.state !== "running" || !env.runtime_id || !env.compute_node_id || (await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued','leased')", [environmentId])).rowCount)
    throw new EnvironmentServiceError(409, "Wait until the environment is running with no lifecycle operation in progress");
  await client.query("SELECT billing_access($1,$2)", [actor.organizationId,environmentId]);
  const config = parseExecution(input, env.workspace_path);
  const environment = parseExecutionEnvironment(input.environment_variables);
  const hasSecrets = Object.keys(environment).length > 0;
  if (hasSecrets && (env.code_trust !== "trusted" || actor.automationIdPrefix)) throw new EnvironmentServiceError(403, "Execution environment variables require trusted code and an unrestricted organization actor");
  await client.query("DELETE FROM sandbox_executions WHERE organization_id = $1 AND status NOT IN ('queued','running') AND updated_at < now() - interval '7 days'", [actor.organizationId]);
  const counts = (await client.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('queued','running'))::int AS active FROM sandbox_executions WHERE organization_id = $1", [actor.organizationId])).rows[0];
  if (counts.active >= 100 || counts.total >= 1000) throw new EnvironmentServiceError(429, "Execution retention limit reached. Delete completed executions or wait for active work");
  if ((await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id = $1 AND status IN ('queued','running')", [environmentId])).rowCount)
    throw new EnvironmentServiceError(409, "An execution is already active in this environment");
  const id = `exec_${crypto.randomUUID()}`;
  await client.query(`INSERT INTO sandbox_executions (id,sandbox_id,organization_id,compute_node_id,command,cwd,timeout_seconds,artifact_paths)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id,environmentId,actor.organizationId,env.compute_node_id,config.command,config.cwd,config.timeout_seconds,JSON.stringify(config.artifact_paths)]);
  if (hasSecrets) {
    const encrypted = encryptSecret(JSON.stringify(environment), executionSecretContext(actor.organizationId, id));
    await client.query("UPDATE sandbox_executions SET encrypted_environment = $2, environment_iv = $3 WHERE id = $1", [id, encrypted.encryptedValue, encrypted.iv]);
    await client.query("UPDATE sandboxes SET has_ever_received_environment_secrets = true WHERE id = $1", [environmentId]);
  }
  await client.query("UPDATE sandboxes SET last_activity_at = now() WHERE id = $1", [environmentId]);
  return { id, environment_id: environmentId, status: "queued" };
}
export async function getExecution(actor: EnvironmentActor, id: string) {
  const row = await authorize(actor,id);
  const artifacts = (await db.query("SELECT path, octet_length(data) AS size, error FROM execution_artifacts WHERE execution_id = $1 ORDER BY path", [id])).rows;
  return { id: row.id, environment_id: row.sandbox_id, status: row.status, exit_code: row.exit_code, cancel_requested: row.cancel_requested,
    stdout_bytes: row.stdout_bytes, stderr_bytes: row.stderr_bytes, created_at: row.created_at, updated_at: row.updated_at, artifacts };
}
export async function cancelExecution(actor: EnvironmentActor, id: string) {
  await authorize(actor,id);
  await db.query("UPDATE sandbox_executions SET cancel_requested = true, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, updated_at = now() WHERE id = $1 AND status IN ('queued','running')", [id]);
  return getExecution(actor,id);
}
export async function deleteExecution(actor: EnvironmentActor, id: string) {
  await authorize(actor,id);
  const result = await db.query("DELETE FROM sandbox_executions WHERE id = $1 AND status NOT IN ('queued','running')", [id]);
  if (!result.rowCount) throw new EnvironmentServiceError(409,"Cancel and wait for the execution before deleting it");
  return { deleted: true };
}
export async function executionOutput(actor: EnvironmentActor, id: string, after = "0") {
  await authorize(actor,id);
  if (!/^\d{1,18}$/.test(after)) throw new EnvironmentServiceError(400,"Invalid output cursor");
  const rows = (await db.query("SELECT sequence::text, stream, byte_offset, data FROM execution_output WHERE execution_id = $1 AND sequence > $2::bigint ORDER BY sequence LIMIT 100", [id,after])).rows;
  return rows.map(row => ({ ...row, data: row.data.toString("base64") }));
}
export async function executionArtifact(actor: EnvironmentActor, id: string, path: string) {
  await authorize(actor,id);
  const row = (await db.query("SELECT data, error FROM execution_artifacts WHERE execution_id = $1 AND path = $2", [id,path])).rows[0];
  if (!row) throw new EnvironmentServiceError(404,"Artifact not found");
  if (row.error) throw new EnvironmentServiceError(409,row.error);
  return row.data as Buffer;
}

export async function pollExecutions(c: Context<AppEnv>) {
  const identity = c.get("computeAgent");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // An environment lifecycle cannot race admission; unavailable runtimes are reported as lost, never replayed.
    const rows = (await client.query(`SELECT e.*, s.runtime_id, s.state AS environment_state FROM sandbox_executions e JOIN sandboxes s ON s.id = e.sandbox_id
      WHERE e.compute_node_id = $1 AND s.compute_node_id = $1 AND ($2::text IS NULL OR e.organization_id = $2)
        AND e.status IN ('queued','running') ORDER BY e.updated_at LIMIT 20 FOR UPDATE OF e SKIP LOCKED`, [identity.id,identity.organizationId])).rows;
    for (const row of rows) {
      await client.query("UPDATE sandbox_executions SET status = 'running', updated_at = now() WHERE id = $1", [row.id]);

    }
    await client.query("COMMIT");
    // Release execution locks before touching sandboxes; lifecycle deletion locks them in the opposite order.
    if (rows.length) await client.query("UPDATE sandboxes SET last_activity_at = now() WHERE id = ANY($1::text[])", [rows.map(row => row.sandbox_id)]);
    return c.json({ executions: rows.map(row => ({ id:row.id,runtime_id:row.runtime_id,environment_state:row.environment_state,command:row.command,cwd:row.cwd,
      environment_variables: row.encrypted_environment ? JSON.parse(decryptSecret(row.encrypted_environment, row.environment_iv, executionSecretContext(row.organization_id, row.id))) : {},
      timeout_seconds:row.timeout_seconds,artifact_paths:row.artifact_paths,cancel_requested:row.cancel_requested,stdout_bytes:row.stdout_bytes,stderr_bytes:row.stderr_bytes })) });
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function reportExecution(c: Context<AppEnv>) {
  const identity = c.get("computeAgent");
  const input = await c.req.json().catch(() => null);
  if (!input || JSON.stringify(input).length > 900000) return c.json({ error:"Invalid execution report" },400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Lock in the same order as snapshot/lifecycle admission. Completed setup must
    // protect its identity even if the browser closed before the result arrived.
    const tailscaleEnvironment = (await client.query("SELECT id FROM sandboxes WHERE tailscale_execution_id=$1 AND compute_node_id=$2 FOR UPDATE", [c.req.param("id"), identity.id])).rows[0];
    const row = (await client.query("SELECT * FROM sandbox_executions WHERE id = $1 AND compute_node_id = $2 AND ($3::text IS NULL OR organization_id = $3) FOR UPDATE", [c.req.param("id"),identity.id,identity.organizationId])).rows[0];
    if (!row) { await client.query("ROLLBACK"); return c.json({error:"Execution not found"},404); }
    if (executionTerminal.has(row.status)) { await client.query("COMMIT"); return c.json({ok:true}); }
    for (const stream of ["stdout","stderr"] as const) {
      const chunk = input[stream];
      if (!chunk) continue;
      if (typeof chunk.data !== "string" || chunk.data.length > 45000 || !Number.isInteger(chunk.offset) || chunk.offset < 0) throw new EnvironmentServiceError(400,"Invalid output chunk");
      const data = Buffer.from(chunk.data,"base64"), expected = row[`${stream}_bytes`];
      if (chunk.offset < expected && chunk.offset + data.length <= expected) continue; // replay after a lost HTTP acknowledgement
      if (chunk.offset !== expected || data.length > 32768 || expected + data.length > 1048576) throw new EnvironmentServiceError(409,"Output cursor mismatch or limit exceeded");
      if (data.length) {
        await client.query("INSERT INTO execution_output (execution_id,stream,byte_offset,data) VALUES ($1,$2,$3,$4)", [row.id,stream,expected,data]);
        await client.query(`UPDATE sandbox_executions SET ${stream}_bytes = $1 WHERE id = $2`, [expected+data.length,row.id]);
      }
    }
    if (executionTerminal.has(input.status)) {
      if (tailscaleEnvironment) {
        const output = (await client.query("SELECT data FROM execution_output WHERE execution_id=$1 AND stream='stdout' ORDER BY sequence", [row.id])).rows;
        const result = parseTailscaleOutput(Buffer.concat(output.map(item => item.data)).toString());
        const loggedOut = row.command === tailscaleCommand("logout") && input.status === "succeeded" && result?.state === "logged_out";
        const configured = result?.state === "connected" || (row.command === tailscaleCommand("connect") && result?.state !== "not_installed");
        if (loggedOut || configured) await client.query("UPDATE sandboxes SET tailscale_configured=$2 WHERE id=$1", [tailscaleEnvironment.id, !loggedOut]);
      }
      if (input.exit_code !== null && (!Number.isInteger(input.exit_code) || Math.abs(input.exit_code) > 255)) throw new EnvironmentServiceError(400,"Invalid exit code");
      const artifacts = input.artifacts ?? [];
      if (!Array.isArray(artifacts) || artifacts.length > 4 || artifacts.some(a => !a || typeof a !== "object" || typeof a.path !== "string") || new Set(artifacts.map(a=>a.path)).size !== artifacts.length) throw new EnvironmentServiceError(400,"Invalid artifacts");
      for (const artifact of artifacts) {
        if (!row.artifact_paths.includes(artifact.path) || (artifact.data !== undefined && (typeof artifact.data !== "string" || artifact.data.length > 175000))) throw new EnvironmentServiceError(400,"Unexpected or oversized artifact");
        const data = artifact.data === undefined ? null : Buffer.from(artifact.data,"base64");
        if (data && data.length > 131072) throw new EnvironmentServiceError(400,"Artifact exceeds 128 KiB");
        await client.query("INSERT INTO execution_artifacts (execution_id,path,data,error) VALUES ($1,$2,$3,$4)", [row.id,artifact.path,data,data === null ? String(artifact.error || "Unavailable").slice(0,300) : null]);
      }
      await client.query("UPDATE sandbox_executions SET status = $1, exit_code = $2 WHERE id = $3", [input.status,input.exit_code,row.id]);
    }
    await client.query("UPDATE sandbox_executions SET updated_at = now() WHERE id = $1", [row.id]);
    await client.query("COMMIT");
    return c.json({ok:true});
  } catch(error) { await client.query("ROLLBACK"); if(error instanceof EnvironmentServiceError) return c.json({error:error.message},error.status as 400); throw error; }
  finally { client.release(); }
}
