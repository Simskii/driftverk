import { config } from "./config.js";
import type { Context } from "hono";
import { db } from "./db.js";
import type { AppEnv, AuthSession } from "./types.js";
import { HTTPException } from "hono/http-exception";

type HostingMode = "managed" | "hybrid";

type ComputeAgentRow = {
  id: string;
  organization_id: string;
  name: string;
  last_seen_at: string | null;
  version: string | null;
  storage_driver: "local" | "s3" | null;
  revoked_at: string | null;
  created_at: string;
};

export function isPlatformAdmin(session: AuthSession): boolean {
  return session.user.isPlatformAdmin === true;
}

function computeAgent(row: ComputeAgentRow) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    last_seen_at: row.last_seen_at,
    version: row.version,
    storage_driver: row.storage_driver,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

export async function adminAccess(c: Context<AppEnv>, session: AuthSession) {
  return c.json({ platform_admin: isPlatformAdmin(session) });
}

export async function listAdminOrganizations(c: Context<AppEnv>) {
  const result = await db.query<{
    id: string;
    name: string;
    slug: string;
    hosting_mode: HostingMode;
    created_at: string;
    primary_contact_name: string | null;
    primary_contact_email: string | null;
    last_environment_activity_at: string | null;
    member_count: number;
    environment_count: number;
    environment_issue_count: number;
    agents: ComputeAgentRow[] | null;
  }>(
    `SELECT organizations.id, organizations.name, organizations.slug,
            organizations.hosting_mode, organizations.created_at,
            (SELECT jsonb_build_object('balance_ore',balance_ore,'currency',currency,'complimentary',complimentary) FROM billing_accounts WHERE organization_id=organizations.id) AS billing,
            (
              SELECT users.name
              FROM memberships AS contact_membership
              JOIN "user" AS users ON users.id = contact_membership.user_id
              WHERE contact_membership.organization_id = organizations.id
              ORDER BY CASE WHEN contact_membership.role = 'admin' THEN 0 ELSE 1 END,
                       contact_membership.created_at
              LIMIT 1
            ) AS primary_contact_name,
            (
              SELECT users.email
              FROM memberships AS contact_membership
              JOIN "user" AS users ON users.id = contact_membership.user_id
              WHERE contact_membership.organization_id = organizations.id
              ORDER BY CASE WHEN contact_membership.role = 'admin' THEN 0 ELSE 1 END,
                       contact_membership.created_at
              LIMIT 1
            ) AS primary_contact_email,
            max(sandboxes.updated_at) FILTER (WHERE sandboxes.state <> 'deleted') AS last_environment_activity_at,
            count(DISTINCT memberships.user_id)::int AS member_count,
            count(DISTINCT sandboxes.id) FILTER (WHERE sandboxes.state <> 'deleted')::int AS environment_count,
            count(DISTINCT sandboxes.id) FILTER (
              WHERE sandboxes.state <> 'deleted'
                AND (sandboxes.state = 'degraded' OR sandboxes.error_message IS NOT NULL)
            )::int AS environment_issue_count,
            coalesce(
              jsonb_agg(DISTINCT jsonb_build_object(
                'id', compute_agents.id,
                'organization_id', compute_agents.organization_id,
                'name', compute_agents.name,
                'last_seen_at', compute_agents.last_seen_at,
                'version', compute_agents.version,
                'storage_driver', compute_agents.storage_driver,
                'revoked_at', compute_agents.revoked_at,
                'created_at', compute_agents.created_at
              )) FILTER (WHERE compute_agents.id IS NOT NULL),
              '[]'::jsonb
            ) AS agents
     FROM organizations
     LEFT JOIN memberships ON memberships.organization_id = organizations.id
     LEFT JOIN sandboxes ON sandboxes.organization_id = organizations.id
     LEFT JOIN compute_agents ON compute_agents.organization_id = organizations.id
     GROUP BY organizations.id
     ORDER BY organizations.created_at DESC`,
  );
  return c.json({
    organizations: result.rows.map((organization) => ({
      ...organization,
      agents: (organization.agents ?? []).map(computeAgent),
    })),
  });
}

export async function updateAdminOrganization(c: Context<AppEnv>) {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const hostingMode = payload?.hosting_mode;
  if (!name || name.length > 120) return c.json({ error: "A valid organization name is required" }, 400);
  if (hostingMode !== "managed" && hostingMode !== "hybrid") return c.json({ error: "hosting_mode must be managed or hybrid" }, 400);
  const current = await db.query<{ hosting_mode: HostingMode }>("SELECT hosting_mode FROM organizations WHERE id = $1", [c.req.param("id")]);
  if (!current.rowCount) return c.json({ error: "Organization not found" }, 404);
  if (current.rows[0]?.hosting_mode !== hostingMode) {
    const environments = await db.query("SELECT 1 FROM sandboxes WHERE organization_id = $1 AND state <> 'deleted' LIMIT 1", [c.req.param("id")]);
    if (environments.rowCount) return c.json({ error: "Hosting mode cannot be changed while the organization has environments" }, 409);
  }
  if (hostingMode === "managed") {
    const active = await db.query(
      "SELECT 1 FROM compute_agents WHERE organization_id = $1 AND revoked_at IS NULL",
      [c.req.param("id")],
    );
    if (active.rowCount) return c.json({ error: "Revoke the active Compute agent before switching to managed hosting" }, 409);
  }
  const result = await db.query(
    `UPDATE organizations SET name = $1, hosting_mode = $2, updated_at = now()
     WHERE id = $3 RETURNING id`,
    [name, hostingMode, c.req.param("id")],
  );
  return c.json({ ok: true });
}

export async function setAdminComplimentaryAccess(c: Context<AppEnv>) {
  if (config.selfHosted) throw new HTTPException(404, { message: "Billing is disabled for this installation" });
  if (!isPlatformAdmin(c.get("authSession"))) throw new HTTPException(403, { message: "Platform admin access required" });
  const input = await c.req.json().catch(() => null);
  if (typeof input?.complimentary !== "boolean") throw new HTTPException(400, { message: "complimentary must be a boolean" });
  const id = c.req.param("id");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Match lifecycle and billing reconciliation lock order.
    await client.query("SELECT id FROM sandboxes WHERE organization_id=$1 AND state<>'deleted' ORDER BY id FOR UPDATE", [id]);
    const account = (await client.query("SELECT * FROM billing_accounts WHERE organization_id=$1 FOR UPDATE", [id])).rows[0];
    if (!account) throw new HTTPException(404, { message: "Organization not found" });
    if (input.complimentary && account.stripe_subscription_id && !["canceled", "incomplete_expired"].includes(account.subscription_status)) {
      throw new HTTPException(409, { message: "Cancel the Stripe subscription before enabling complimentary access." });
    }
    if (input.complimentary) {
      const pending = await client.query("SELECT 1 FROM billing_checkouts WHERE organization_id=$1 AND completed_at IS NULL AND abandoned_at IS NULL LIMIT 1", [id]);
      if (pending.rowCount) throw new HTTPException(409, { message: "Resolve pending Stripe checkouts before enabling complimentary access." });
    }
    if (account.complimentary !== input.complimentary) {
      await client.query("SELECT billing_settle($1)", [id]);
      // Free usage must never be billed when complimentary access ends.
      await client.query("UPDATE billing_resources SET metered_at=clock_timestamp() WHERE organization_id=$1", [id]);
      await client.query("UPDATE billing_accounts SET complimentary=$2,exhausted_at=NULL WHERE organization_id=$1", [id, input.complimentary]);
    }
    await client.query("COMMIT");
    return c.json({ ok: true, complimentary: input.complimentary });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function grantAdminCredit(c: Context<AppEnv>) {
  if (config.selfHosted) throw new HTTPException(404, { message: "Billing is disabled for this installation" });
  const session = c.get("authSession");
  if (!isPlatformAdmin(session)) throw new HTTPException(403, { message: "Platform admin access required" });
  const input = await c.req.json().catch(() => null);
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (!Number.isSafeInteger(input?.amount_ore) || input.amount_ore < 1 || input.amount_ore > 1_000_000 || !reason || reason.length > 300 || !/^[0-9a-f-]{36}$/i.test(input?.request_id ?? "")) {
    throw new HTTPException(400, { message: "Enter an amount between 0.01 and 10,000, a reason up to 300 characters, and a request ID" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const account = (await client.query(`SELECT b.*,o.hosting_mode FROM billing_accounts b JOIN organizations o ON o.id=b.organization_id WHERE b.organization_id=$1 FOR UPDATE OF b`, [c.req.param("id")])).rows[0];
    if (!account) throw new HTTPException(404, { message: "Organization not found" });
    if (account.hosting_mode !== "managed" || account.complimentary) throw new HTTPException(409, { message: "Credits require a metered Cloud organization" });
    if (input.currency !== account.currency) throw new HTTPException(409, { message: "Currency changed. Reload the organization" });
    const reference = `admin-grant:${input.request_id}`;
    const existing = (await client.query("SELECT * FROM billing_ledger WHERE reference=$1", [reference])).rows[0];
    if (existing && (existing.organization_id !== account.organization_id || Number(existing.amount_ore) !== input.amount_ore || existing.description !== reason || existing.granted_by_user_id !== session.user.id)) throw new HTTPException(409, { message: "Request ID already used for another grant" });
    if (!existing) {
      await client.query("SELECT billing_settle($1)", [account.organization_id]);
      await client.query("INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description,granted_by_user_id) VALUES($1,$2,'grant',$3,$4,$5)", [account.organization_id,input.amount_ore,reference,reason,session.user.id]);
      await client.query("UPDATE billing_accounts SET balance_ore=balance_ore+$2,exhausted_at=NULL WHERE organization_id=$1", [account.organization_id,input.amount_ore]);
    }
    await client.query("COMMIT");
    return c.json({ ok: true });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function revokeAdminComputeAgent(c: Context<AppEnv>) {
  const result = await db.query(
    `UPDATE compute_agents SET revoked_at = now(), updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING id`,
    [c.req.param("agentId"), c.req.param("organizationId")],
  );
  if (!result.rowCount) return c.json({ error: "Active Compute agent not found" }, 404);
  return c.json({ ok: true });
}
