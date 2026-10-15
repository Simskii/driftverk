import type { Context } from "hono";
import { db } from "./db.js";
import { oauthWorkspaceFor } from "./oauth-workspace.js";
import type { AppEnv, AuthSession } from "./types.js";

const scopeLabels: Record<string, string> = {
  "mcp:read": "View environments, snapshots and operation status",
  "mcp:write": "Create, start and stop environments",
  "mcp:delete": "Delete environments",
  offline_access: "Stay connected until you revoke access",
};

export async function getOAuthConsentContext(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await oauthWorkspaceFor(session.user.id, session.session.activeOrganizationId);
  if (!workspace) return c.json({ error: "Organization membership required" }, 403);
  const clientId = c.req.query("client_id") ?? "";
  const client = clientId
    ? await db.query<{ name: string | null }>(
        `SELECT name FROM "oauthClient" WHERE "clientId" = $1 AND "disabled" IS NOT TRUE`,
        [clientId],
      )
    : null;
  const requestedScopes = (c.req.query("scope") ?? "")
    .split(/\s+/)
    .filter((scope) => scope in scopeLabels);
  return c.json({
    client_name: client?.rows[0]?.name || "AI client",
    organization: { id: workspace.organization_id, name: workspace.organization_name },
    scopes: requestedScopes.map((scope) => ({ id: scope, label: scopeLabels[scope] })),
  });
}
