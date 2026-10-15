import type { Context, Next } from "hono";
import { db } from "./db.js";
import type { AppEnv } from "./types.js";
import { workspaceFor } from "./workspace.js";

export async function hasEnvironmentAccess(environmentId: string, userId: string) {
  const result = await db.query("SELECT 1 WHERE can_access_environment($1, $2)", [environmentId, userId]);
  return Boolean(result.rowCount);
}

export async function requireEnvironmentAccess(c: Context<AppEnv>, next: Next) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  const result = await db.query(
    "SELECT 1 FROM sandboxes WHERE id=$1 AND organization_id=$2 AND can_access_environment(id,$3)",
    [c.req.param("id"), workspace.organization_id, session.user.id],
  );
  if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
  await next();
}

export async function environmentMembers(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const members = await db.query(`SELECT m.id, u.name, u.email, m.role,
    (m.role IN ('admin','owner') OR em.membership_id IS NOT NULL) AS has_access
    FROM memberships m JOIN "user" u ON u.id=m.user_id
    LEFT JOIN environment_members em ON em.membership_id=m.id AND em.sandbox_id=$2
    WHERE m.organization_id=$1 ORDER BY u.name, u.email`, [workspace.organization_id, c.req.param("id")]);
  return c.json({ members: members.rows });
}

export async function memberEnvironments(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const member = await db.query("SELECT id, role FROM memberships WHERE id=$1 AND organization_id=$2", [c.req.param("memberId"), workspace.organization_id]);
  if (!member.rowCount) return c.json({ error: "Member not found" }, 404);
  const environments = await db.query(`SELECT s.id, s.name,
    ($3::text IN ('admin','owner') OR em.membership_id IS NOT NULL) AS has_access
    FROM sandboxes s LEFT JOIN environment_members em ON em.sandbox_id=s.id AND em.membership_id=$2
    WHERE s.organization_id=$1 AND s.purpose='development' AND s.state<>'deleted' AND s.desired_state<>'deleted'
      AND (s.preview_template_id IS NULL OR s.preview_claim_key IS NOT NULL)
    ORDER BY s.name`, [workspace.organization_id, c.req.param("memberId"), member.rows[0].role]);
  return c.json({ role: member.rows[0].role, environments: environments.rows });
}

export async function setEnvironmentMember(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json().catch(() => null);
  if (!input || typeof input.has_access !== "boolean") return c.json({ error: "has_access must be true or false" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const member = await client.query("SELECT id, role FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE", [c.req.param("memberId"), workspace.organization_id]);
    const environment = await client.query("SELECT id FROM sandboxes WHERE id=$1 AND organization_id=$2 AND purpose='development' AND state<>'deleted' AND desired_state<>'deleted' FOR UPDATE", [c.req.param("id"), workspace.organization_id]);
    if (!member.rowCount || !environment.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "Member or environment not found" }, 404);
    }
    if (member.rows[0].role !== "member") {
      await client.query("ROLLBACK");
      return c.json({ error: "Admins always have access to all environments" }, 400);
    }
    const args = [c.req.param("id"), c.req.param("memberId")];
    if (input.has_access) await client.query("INSERT INTO environment_members (sandbox_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", args);
    else await client.query("DELETE FROM environment_members WHERE sandbox_id=$1 AND membership_id=$2", args);
    await client.query("COMMIT");
    return c.json({ has_access: input.has_access });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
