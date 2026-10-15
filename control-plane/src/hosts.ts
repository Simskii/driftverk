import type { Context } from "hono";
import { db } from "./db.js";
import { computeAgentVersion } from './compute-agent-version.js';
import { config } from "./config.js";
import type { AppEnv } from "./types.js";
import { workspaceFor } from "./workspace.js";

export async function listHosts(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  const [organization, hosts] = await Promise.all([
    db.query("SELECT hosting_mode FROM organizations WHERE id = $1", [workspace.organization_id]),
    db.query(`SELECT a.id, a.name, a.last_seen_at, a.version, a.storage_driver, a.cpu_count, a.memory_mb, a.health, a.health_checked_at,
      count(s.id)::int AS environment_count
      FROM compute_agents a LEFT JOIN sandboxes s ON s.compute_node_id = a.id AND s.state <> 'deleted'
      WHERE a.organization_id = $1 AND a.revoked_at IS NULL
      GROUP BY a.id ORDER BY a.created_at`, [workspace.organization_id]),
  ]);
  return c.json({ hosting_mode: organization.rows[0].hosting_mode, role: workspace.role, hosts: hosts.rows, latest_agent_version: computeAgentVersion,
    install_command: `curl -fsSL ${config.betterAuthUrl.replace(/\/$/, "")}/install/agent | sudo bash -s --` });
}

export async function updateHosting(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Workspace admin access is required" }, 403);
  const mode = (await c.req.json().catch(() => null))?.hosting_mode;
  if (config.selfHosted && mode !== "hybrid") return c.json({ error: "This installation uses its own compute hosts" }, 400);
  if (mode !== "managed" && mode !== "hybrid") return c.json({ error: "Choose Cloud or Hybrid" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT hosting_mode FROM organizations WHERE id = $1 FOR UPDATE", [workspace.organization_id]);
    if (current.rows[0].hosting_mode !== mode) {
      const used = await client.query(`SELECT 1 FROM sandboxes WHERE organization_id = $1 AND state <> 'deleted'
        UNION ALL SELECT 1 FROM compute_agents WHERE organization_id = $1 AND revoked_at IS NULL LIMIT 1`, [workspace.organization_id]);
      if (used.rowCount) return c.json({ error: "Hosting can only change before connecting hosts or creating environments" }, 409);
      await client.query("UPDATE organizations SET hosting_mode = $1, updated_at = now() WHERE id = $2", [mode, workspace.organization_id]);
    }
    await client.query("COMMIT");
    return c.json({ ok: true });
  } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
}

export async function removeHost(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Workspace admin access is required" }, 403);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const host = await client.query("SELECT id FROM compute_agents WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL FOR UPDATE", [c.req.param("id"), workspace.organization_id]);
    if (!host.rowCount) return c.json({ error: "Host not found" }, 404);
    const used = await client.query(`SELECT 1 FROM sandboxes WHERE compute_node_id = $1 AND state <> 'deleted'
      UNION ALL SELECT 1 FROM workspace_volumes WHERE compute_node_id = $1
      UNION ALL SELECT 1 FROM workspace_snapshots snap JOIN sandboxes s ON s.id = snap.source_sandbox_id
        WHERE s.compute_node_id = $1 AND snap.status = 'ready' AND snap.artifact_ref NOT LIKE 's3://%' LIMIT 1`, [c.req.param("id")]);
    if (used.rowCount) return c.json({ error: "This host still owns environments, local snapshots or volumes. Keep it connected until its data is no longer needed." }, 409);
    await client.query("UPDATE compute_agents SET revoked_at = now(), updated_at = now() WHERE id = $1", [c.req.param("id")]);
    await client.query("COMMIT");
    return c.json({ ok: true });
  } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
}
