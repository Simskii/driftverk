import { db } from "./db.js";

export type OAuthWorkspace = {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  role: "admin" | "member";
};

export async function oauthWorkspaceFor(
  userId: string,
  activeOrganizationId?: string | null,
): Promise<OAuthWorkspace | null> {
  const result = await db.query<OAuthWorkspace>(
    `SELECT memberships.organization_id, organizations.name AS organization_name,
            organizations.slug AS organization_slug, memberships.role
     FROM memberships
     JOIN organizations ON organizations.id = memberships.organization_id
     WHERE memberships.user_id = $1
       AND ($2::text IS NULL OR memberships.organization_id = $2)
     ORDER BY memberships.created_at ASC
     LIMIT 1`,
    [userId, activeOrganizationId || null],
  );
  return result.rows[0] ?? null;
}
