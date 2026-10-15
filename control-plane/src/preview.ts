import type { Context } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import { createPreviewToken } from "./preview-token.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";
import { queueEnvironmentWake } from "./lifecycle.js";

export class PreviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function createPreviewGrant(organizationId: string, sandboxId: string, port: number, userId?: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new PreviewError(400, "Invalid port");
  const result = await db.query<{ preview_id: string; compute_node_id: string; state: string; preview_enabled: boolean }>(
    `SELECT preview_id, compute_node_id, state, preview_enabled FROM sandboxes
     WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted' AND desired_state <> 'deleted'
       AND compute_node_id IS NOT NULL AND runtime_id IS NOT NULL`,
    [sandboxId, organizationId],
  );
  const environment = result.rows[0];
  if (!environment) throw new PreviewError(409, "The environment must be provisioned before opening a preview");
  await db.query("SELECT billing_access($1,$2,true)", [organizationId,sandboxId]);
  if (!environment.preview_enabled) throw new PreviewError(403, "Preview access is disabled for this environment");
  if (environment.state !== "running") {
    const wake = await queueEnvironmentWake(sandboxId);
    if (wake.status === "stopped") throw new PreviewError(409, "Environment was stopped manually. Start it from the web interface or run driftverk start <environment>.");
    if (wake.status === "unavailable") throw new PreviewError(409, "The environment could not start. Check its lifecycle logs.");
  }
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const token = createPreviewToken({ userId, sandboxId, nodeId: environment.compute_node_id, port, expiresAt }, config.previewTokenSecret);
  return {
    url: `https://${port}-${environment.preview_id}.${config.previewDomain}/?token=${encodeURIComponent(token)}`,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export async function createPreview(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const sandboxId = c.req.param("id") ?? "";
  const port = Number(c.req.param("port"));
  try {
    const grant = await createPreviewGrant(workspace.organization_id, sandboxId, port, authSession.user.id);
    return c.json(grant, "status" in grant ? 202 : 200);
  } catch (error) {
    if (error instanceof PreviewError) return c.json({ error: error.message }, error.status as 400);
    throw error;
  }
}
