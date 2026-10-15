import type { Context } from "hono";
import { db } from "./db.js";
import { workspaceFor } from "./workspace.js";
import { createExecution, executionTerminal } from "./executions.js";
import { EnvironmentServiceError } from "./environment-service.js";
import { parseTailscaleOutput, tailscaleCommand } from "./tailscale-command.js";
import type { AppEnv, AuthSession } from "./types.js";

export async function environmentTailscale(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  c.header("Cache-Control", "no-store");
  const environmentId = c.req.param("id")!;
  if (c.req.method === "GET") {
    const env = (await db.query("SELECT tailscale_execution_id FROM sandboxes WHERE id=$1 AND organization_id=$2 AND purpose='development' AND state<>'deleted'", [environmentId, workspace.organization_id])).rows[0];
    if (!env) return c.json({ error: "Environment not found" }, 404);
    const execution = (await db.query("SELECT status, command, updated_at FROM sandbox_executions WHERE id=$1 AND sandbox_id=$2 AND organization_id=$3", [env.tailscale_execution_id, environmentId, workspace.organization_id])).rows[0];
    if (!execution) return c.json({ state: "unknown", pending: false });
    const rows = (await db.query("SELECT data FROM execution_output WHERE execution_id=$1 AND stream='stdout' ORDER BY sequence", [env.tailscale_execution_id])).rows;
    const result = parseTailscaleOutput(Buffer.concat(rows.map(row => row.data)).toString());
    const pending = !executionTerminal.has(execution.status);
    return c.json({ ...(result || { state: pending ? "checking" : "error" }), pending, checked_at: execution.updated_at });
  }
  const input = await c.req.json().catch(() => null);
  const action = input?.action;
  if (!["status", "connect", "logout"].includes(action)) return c.json({ error: "Invalid Tailscale action" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Match execution admission's lock order.
    await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [workspace.organization_id]);
    const env = (await client.query("SELECT code_trust FROM sandboxes WHERE id=$1 AND organization_id=$2 AND purpose='development' AND state<>'deleted' FOR UPDATE", [environmentId, workspace.organization_id])).rows[0];
    if (!env) throw new EnvironmentServiceError(404, "Environment not found");
    if (env.code_trust !== "trusted") throw new EnvironmentServiceError(403, "Tailscale setup requires a trusted environment");
    const execution = await createExecution({ organizationId: workspace.organization_id, organizationName: workspace.organization_name,
      organizationSlug: workspace.organization_slug, actorUserId: session.user.id, automationIdPrefix: null }, environmentId,
      { command: tailscaleCommand(action), cwd: "/", timeout_seconds: action === "connect" ? 150 : 30 }, client);
    await client.query("UPDATE sandboxes SET tailscale_execution_id=$2 WHERE id=$1", [environmentId, execution.id]);
    await client.query("COMMIT");
    return c.json({ state: "checking", pending: true }, 202);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof EnvironmentServiceError) return c.json({ error: error.message }, error.status as 400);
    throw error;
  } finally { client.release(); }
}
