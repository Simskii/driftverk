import type { Context } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import { createTerminalToken } from "./terminal-token.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";
import { queueEnvironmentWake } from "./lifecycle.js";

export async function createTerminalTicket(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const sandboxId = c.req.param("id") ?? "";
  const result = await db.query<{ compute_node_id: string; state: string; runtime_id: string | null; provisioning_step: string; desired_state: string; code_trust: string; agent_configuration: unknown }>(
    `SELECT compute_node_id, state, runtime_id, provisioning_step, desired_state, code_trust, agent_configuration FROM sandboxes
     WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted'
       AND compute_node_id IS NOT NULL`,
    [sandboxId, workspace.organization_id],
  );
  const environment = result.rows[0];
  if (!environment) return c.json({ error: "The environment is not available" }, 409);
  const input = await c.req.json().catch(() => null);
  if (input?.agent !== undefined && typeof input.agent !== "boolean") return c.json({ error: "Invalid agent selection" }, 400);
  if (input?.agent && (environment.code_trust !== "trusted" || !environment.agent_configuration)) return c.json({ error: "This environment has no configured agent" }, 409);
  await db.query("SELECT billing_access($1,$2)", [workspace.organization_id,sandboxId]);
  const setupFailed = environment.state === "degraded" && environment.desired_state === "running" && ["cloning", "setting-up", "initializing", "starting-services", "checking-app"].includes(environment.provisioning_step);
  if (!environment.runtime_id || (environment.state !== "running" && !setupFailed)) {
    const wake = await queueEnvironmentWake(sandboxId);
    if (wake.status === "stopped") return c.json({ error: "Environment was stopped manually. Start it from the web interface or run driftverk start <environment>." }, 409);
    if (wake.status === "unavailable") return c.json({ error: "The environment could not start. Check its lifecycle logs." }, 409);
    if (wake.status === "starting") return c.json(wake, 202);
  }
  const expiresAt = Date.now() + 60_000;
  const token = createTerminalToken({
    sandboxId,
    agent: input?.agent === true,
    userId: authSession.user.id,
    nodeId: environment.compute_node_id,
    expiresAt,
    nonce: crypto.randomUUID(),
  }, config.terminalTokenSecret);
  return c.json({ token, websocket_path: "/api/terminal", expires_at: new Date(expiresAt).toISOString() });
}
