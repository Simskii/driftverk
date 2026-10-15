import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";
import { normalizeUserCode } from "./compute-agent-setup-code.js";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const setupLifetimeMinutes = 10;

type SetupRow = {
  user_code: string;
  requested_name: string;
  organization_id: string | null;
  approved_at: string | null;
  consumed_at: string | null;
  expires_at: string;
  compute_node_id?: string | null;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(bytes, (byte) => codeAlphabet[byte % codeAlphabet.length]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export async function startComputeAgentSetup(c: Context<AppEnv>) {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null);
  const requestedName = typeof payload?.name === "string" ? payload.name.trim().slice(0, 80) : "";
  if (!requestedName) return c.json({ error: "A Compute agent name is required" }, 400);

  const deviceCode = randomBytes(32).toString("base64url");
  let code = userCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.query(
        `INSERT INTO compute_agent_authorizations
         (device_code_hash, user_code, requested_name, expires_at)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))`,
        [hash(deviceCode), code, requestedName, setupLifetimeMinutes],
      );
      return c.json({
        device_code: deviceCode,
        user_code: code,
        verification_uri: `${config.betterAuthUrl.replace(/\/$/, "")}/connect`,
        verification_uri_complete: `${config.betterAuthUrl.replace(/\/$/, "")}/connect?code=${encodeURIComponent(code)}`,
        expires_in: setupLifetimeMinutes * 60,
        interval: 2,
      }, 201);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") throw error;
      code = userCode();
    }
  }
  return c.json({ error: "Could not create a unique setup code" }, 503);
}

export async function getComputeAgentSetup(c: Context<AppEnv>, session: AuthSession) {
  const code = normalizeUserCode(c.req.query("code"));
  if (!code) return c.json({ error: "Enter the eight-character code shown in the terminal" }, 400);
  const result = await db.query<SetupRow>(
    `SELECT user_code, requested_name, organization_id, approved_at, consumed_at, expires_at, compute_node_id
     FROM compute_agent_authorizations WHERE user_code = $1`,
    [code],
  );
  const setup = result.rows[0];
  if (!setup || (!setup.approved_at && new Date(setup.expires_at).getTime() <= Date.now())) return c.json({ error: "This setup code has expired" }, 410);
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (setup.organization_id && setup.organization_id !== workspace.organization_id)
    return c.json({ error: "This connection belongs to another organization" }, 403);
  const host = setup.compute_node_id ? (await db.query(
    "SELECT id, name, last_seen_at, storage_driver, revoked_at FROM compute_agents WHERE id = $1 AND organization_id = $2",
    [setup.compute_node_id, workspace.organization_id],
  )).rows[0] : null;
  return c.json({
    code: setup.user_code,
    agent_name: setup.requested_name,
    organization_name: workspace.organization_name,
    can_approve: workspace.role === "admin" && !setup.approved_at && !setup.consumed_at,
    approved: Boolean(setup.approved_at),
    consumed: Boolean(setup.consumed_at),
    host,
  });
}

export async function approveComputeAgentSetup(c: Context<AppEnv>, session: AuthSession) {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null);
  const code = normalizeUserCode(payload?.code);
  if (!code) return c.json({ error: "A valid setup code is required" }, 400);
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Workspace admin access is required" }, 403);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const setupResult = await client.query<SetupRow>(
      `SELECT user_code, requested_name, organization_id, approved_at, consumed_at, expires_at
       FROM compute_agent_authorizations WHERE user_code = $1 FOR UPDATE`,
      [code],
    );
    const setup = setupResult.rows[0];
    if (!setup || new Date(setup.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return c.json({ error: "This setup code has expired" }, 410);
    }
    if (setup.consumed_at) {
      await client.query("ROLLBACK");
      return c.json({ error: "This setup code has already been used" }, 409);
    }
    if (setup.approved_at) {
      await client.query("ROLLBACK");
      return c.json({ error: "This setup code has already been approved" }, 409);
    }
    const organization = await client.query<{ hosting_mode: string }>(
      "SELECT hosting_mode FROM organizations WHERE id = $1 FOR UPDATE",
      [workspace.organization_id],
    );
    if (organization.rows[0]?.hosting_mode !== "hybrid") {
      await client.query("ROLLBACK");
      return c.json({ error: "Hybrid hosting must be enabled for this organization" }, 409);
    }
    await client.query(
      `UPDATE compute_agent_authorizations
       SET organization_id = $1, approved_by_user_id = $2, approved_at = now()
       WHERE user_code = $3`,
      [workspace.organization_id, session.user.id, code],
    );
    await client.query("COMMIT");
    return c.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function pollComputeAgentSetup(c: Context<AppEnv>) {
  const payload = await c.req.json<Record<string, unknown>>().catch(() => null);
  const deviceCode = typeof payload?.device_code === "string" ? payload.device_code : "";
  if (!deviceCode) return c.json({ error: "device_code is required" }, 400);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<SetupRow>(
      `SELECT user_code, requested_name, organization_id, approved_at, consumed_at, expires_at
       FROM compute_agent_authorizations WHERE device_code_hash = $1 FOR UPDATE`,
      [hash(deviceCode)],
    );
    const setup = result.rows[0];
    if (!setup) {
      await client.query("ROLLBACK");
      return c.json({ error: "Invalid device code" }, 400);
    }
    if (new Date(setup.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return c.json({ error: "Setup code expired" }, 410);
    }
    if (setup.consumed_at) {
      await client.query("ROLLBACK");
      return c.json({ error: "Setup code already used" }, 409);
    }
    if (!setup.approved_at || !setup.organization_id) {
      await client.query("ROLLBACK");
      return c.json({ error: "authorization_pending" }, 428);
    }

    const agentId = `agent_${randomUUID()}`;
    const organization = await client.query("SELECT id FROM organizations WHERE id = $1 AND hosting_mode = 'hybrid' FOR UPDATE", [setup.organization_id]);
    if (!organization.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "Hybrid hosting is no longer enabled" }, 409);
    }
    const token = `dvr_${randomBytes(32).toString("base64url")}`;
    await client.query(
      `INSERT INTO compute_agents (id, organization_id, name, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [agentId, setup.organization_id, setup.requested_name, hash(token)],
    );
    await client.query(
      "UPDATE compute_agent_authorizations SET consumed_at = now(), compute_node_id = $2 WHERE device_code_hash = $1",
      [hash(deviceCode), agentId],
    );
    await client.query("COMMIT");
    return c.json({
      control_plane_url: config.betterAuthUrl,
      preview_domain: config.previewDomain,
      panel_hostname: new URL(config.betterAuthUrl).hostname,
      compute_agent_token: token,
      compute_node_id: agentId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
