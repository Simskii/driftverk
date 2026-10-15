import type { Context } from "hono";
import { db } from "./db.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";

type Volume = {
  id: string;
  name: string;
  storage_prefix: string;
  created_at: Date;
  mount_count: number;
};

export async function listVolumes(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const result = await db.query<Volume>(
    `SELECT workspace_volumes.id, workspace_volumes.name, workspace_volumes.storage_prefix,
            workspace_volumes.created_at,
            count(DISTINCT CASE WHEN sandboxes.id IS NOT NULL THEN sandbox_volume_mounts.sandbox_id END)::int AS mount_count
     FROM workspace_volumes
     LEFT JOIN sandbox_volume_mounts ON sandbox_volume_mounts.volume_id = workspace_volumes.id
     LEFT JOIN sandboxes ON sandboxes.id = sandbox_volume_mounts.sandbox_id AND sandboxes.state <> 'deleted'
     WHERE workspace_volumes.organization_id = $1
     GROUP BY workspace_volumes.id
     ORDER BY workspace_volumes.created_at DESC`,
    [workspace.organization_id],
  );
  return c.json({ volumes: result.rows });
}

export async function createVolume(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    return c.json({ error: "Use a lowercase name with letters, numbers and hyphens" }, 400);
  const id = `vol_${crypto.randomUUID()}`;
  const storagePrefix = `${workspace.organization_id}/${id}`;
  try {
    await db.query(
      `INSERT INTO workspace_volumes (id, organization_id, name, storage_prefix, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, workspace.organization_id, name, storagePrefix, authSession.user.id],
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "A volume with that name already exists" }, 409);
    throw error;
  }
  return c.json({ id, name, storage_prefix: storagePrefix }, 201);
}
