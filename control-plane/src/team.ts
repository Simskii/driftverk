import type { Context } from "hono";
import { db } from "./db.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";

type TeamMember = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  created_at: Date;
  environment_count: number;
  running_environment_count: number;
};

type TeamInvitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  status: "pending";
  expires_at: Date | null;
  created_at: Date;
};

export async function listTeam(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const [members, invitations] = await Promise.all([
    db.query<TeamMember>(
      `SELECT memberships.id, memberships.user_id, "user".name, "user".email,
              memberships.role, memberships.created_at,
              count(sandboxes.id)::int AS environment_count,
              count(sandboxes.id) FILTER (WHERE sandboxes.state = 'running')::int AS running_environment_count
       FROM memberships
       JOIN "user" ON "user".id = memberships.user_id
       LEFT JOIN sandboxes ON sandboxes.organization_id = memberships.organization_id
         AND can_access_environment(sandboxes.id, memberships.user_id)
         AND sandboxes.state <> 'deleted'
       WHERE memberships.organization_id = $1
       GROUP BY memberships.id, memberships.user_id, "user".name, "user".email,
                memberships.role, memberships.created_at
       ORDER BY memberships.created_at ASC`,
      [workspace.organization_id],
    ),
    db.query<TeamInvitation>(
      `SELECT id, email, role, status, expires_at, created_at
       FROM invitations
       WHERE organization_id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC`,
      [workspace.organization_id],
    ),
  ]);

  return c.json({
    workspace: {
      id: workspace.organization_id,
      name: workspace.organization_name,
      role: workspace.role,
    },
    current_user_id: authSession.user.id,
    members: members.rows,
    invitations: invitations.rows,
  });
}
