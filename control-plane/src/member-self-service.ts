import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Pool, PoolClient } from "pg";
import { db } from "./db.js";
import { config } from "./config.js";
import { workspaceFor } from "./workspace.js";
import type { AppEnv } from "./types.js";

type Queryable = Pick<Pool | PoolClient, "query">;
export type MemberPolicy = { enabled: boolean; cpu: number; memory_mb: number; image: string };

export async function memberPolicy(organizationId: string, client: Queryable = db, lock = false): Promise<MemberPolicy> {
  const row = (await client.query(`SELECT member_creation_enabled AS enabled,
    member_environment_cpu AS cpu, member_environment_memory_mb AS memory_mb
    FROM organizations WHERE id=$1${lock ? " FOR SHARE" : ""}`, [organizationId])).rows[0];
  if (!row) throw new HTTPException(403, { message: "Workspace no longer exists" });
  const image = (await client.query("SELECT image_ref FROM system_snapshots WHERE is_default=true LIMIT 1")).rows[0]?.image_ref || config.defaultSandboxImage;
  return { ...row, image };
}

export function memberCreationInput(input: Record<string, unknown>, policy: MemberPolicy) {
  if (!policy.enabled) throw new HTTPException(403, { message: "Member environment creation is disabled. Ask a workspace admin." });
  const allowed = new Set(["name", "source_type", "image", "cpu", "memory_mb", "disk_gb", "repository", "repository_branch", "setup_command", "startup_command", "readiness_command", "initialization_command", "workspace_path", "preview_port", "preview_enabled", "environment_variables"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new HTTPException(403, { message: `Only admins can configure ${key.replaceAll("_", " ")}.` });
  }
  if ((input.source_type !== undefined && input.source_type !== "image") || (input.image !== undefined && input.image !== policy.image))
    throw new HTTPException(403, { message: "Members must use Driftverk Dev." });
  for (const [key, expected] of Object.entries({ cpu: policy.cpu, memory_mb: policy.memory_mb, disk_gb: 40 })) {
    if (input[key] !== undefined && input[key] !== expected)
      throw new HTTPException(403, { message: "Use the environment size approved by your workspace admin." });
  }
  return { ...input, source_type: "image", image: policy.image, cpu: policy.cpu, memory_mb: policy.memory_mb, disk_gb: 40 };
}

export async function memberCreationSettings(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (c.req.method === "PUT") {
    if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input.enabled !== "boolean" || ![1,2,4,8].includes(input.cpu) || ![1024,2048,4096,8192,16384].includes(input.memory_mb))
      return c.json({ error: "Choose a valid enabled setting, CPU count and memory size." }, 400);
    await db.query(`UPDATE organizations SET member_creation_enabled=$2, member_environment_cpu=$3,
      member_environment_memory_mb=$4 WHERE id=$1`, [workspace.organization_id, input.enabled, input.cpu, input.memory_mb]);
  }
  const policy = await memberPolicy(workspace.organization_id);
  const existing = (await db.query(`SELECT id, name, state FROM sandboxes
    WHERE organization_id=$1 AND personal_owner_user_id=$2 AND state<>'deleted'`, [workspace.organization_id, session.user.id])).rows[0] ?? null;
  return c.json({ ...policy, image_name: "Driftverk Dev", disk_gb: 40, role: workspace.role, existing,
    can_create: workspace.role === "admin" || (policy.enabled && !existing) });
}
