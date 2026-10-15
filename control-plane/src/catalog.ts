import { snapshotLaunchConfiguration } from "./snapshot-configuration.js";
import { listSystemSnapshots } from "./system-snapshots.js";
import type { Context } from "hono";
import { db } from "./db.js";
import { encryptSecret, secretContext } from "./secrets.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";

export async function listSnapshots(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const result = await db.query(
    `SELECT id, name, version, status, kind, base_image, source_sandbox_id,
            snapshot_size_gb, error_message, created_at, last_used_at, launch_configuration
     FROM workspace_snapshots WHERE organization_id = $1
       AND ($2::boolean OR can_access_environment(source_sandbox_id,$3)) ORDER BY created_at DESC`,
    [workspace.organization_id, workspace.role === "admin", authSession.user.id],
  );
  return c.json({ snapshots: [...await listSystemSnapshots(), ...result.rows] });
}

export async function createSnapshot(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  const sandboxId = String(input?.environment_id ?? "").trim();
  const requestedName = String(input?.name ?? "").trim().toLowerCase();
  const name = requestedName || `snapshot-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    return c.json({ error: "Invalid snapshot name" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sandbox = await client.query<{ tailscale_configured: boolean; source_image: string | null; state: string; runtime_id: string | null; cpu_count: number; memory_mb: number; workspace_path: string | null; startup_command: string | null; readiness_command: string | null; preview_enabled: boolean; preview_port: number | null }>(
      `SELECT tailscale_configured, source_image, state, runtime_id, cpu_count, memory_mb, workspace_path, startup_command, readiness_command, preview_enabled, preview_port FROM sandboxes
       WHERE id = $1 AND organization_id = $2 AND state <> 'deleted' FOR UPDATE`,
      [sandboxId, workspace.organization_id],
    );
    if (!sandbox.rows[0]) {
      await client.query("ROLLBACK");
      return c.json({ error: "Environment not found" }, 404);
    }
    if (!sandbox.rows[0].runtime_id || !new Set(["running", "stopped"]).has(sandbox.rows[0].state)) {
      await client.query("ROLLBACK");
      return c.json({ error: "The environment must be provisioned before it can be captured" }, 409);
    }
    if (sandbox.rows[0].state !== "stopped") {
      await client.query("ROLLBACK");
      return c.json({ error: "Stop the environment before creating a snapshot so all filesystem changes are captured." }, 409);
    }
    if (sandbox.rows[0].tailscale_configured) {
      await client.query("ROLLBACK");
      return c.json({ error: "Sign out of Tailscale in environment settings before capturing a snapshot." }, 409);
    }
    if ((await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id = $1 AND status IN ('queued','running')", [sandboxId])).rowCount) {
      await client.query("ROLLBACK"); return c.json({ error: "Wait for the active execution before capturing a snapshot" },409);
    }
    const active = await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued', 'leased')", [sandboxId]);
    if (active.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "Wait for the active environment operation to finish" }, 409);
    }
    const snapshotId = `snap_${crypto.randomUUID()}`;
    const version = `v${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
    await client.query(
      `INSERT INTO workspace_snapshots
       (id, organization_id, name, version, status, kind, base_image, source_sandbox_id, created_by_user_id, launch_configuration)
       VALUES ($1, $2, $3, $4, 'building', 'filesystem', $5, $6, $7, $8)`,
      [snapshotId, workspace.organization_id, name, version, sandbox.rows[0].source_image || "snapshot", sandboxId, authSession.user.id, JSON.stringify(snapshotLaunchConfiguration(sandbox.rows[0]))],
    );
    await client.query(
      `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step, snapshot_id)
       VALUES ($1, $2, 'snapshot', 'queued', 'restoring', $3)`,
      [`job_${crypto.randomUUID()}`, sandboxId, snapshotId],
    );
    await client.query("COMMIT");
    return c.json({ id: snapshotId, status: "building" }, 202);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "A snapshot with that name already exists" }, 409);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSnapshot(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const snapshotId = c.req.param("id");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await client.query(
      "SELECT 1 FROM workspace_snapshots WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [snapshotId, workspace.organization_id],
    );
    if (!snapshot.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "Snapshot not found" }, 404);
    }
    const activeUse = await client.query(
      `SELECT 1 FROM compute_jobs job
       LEFT JOIN sandboxes sandbox ON sandbox.id = job.sandbox_id
       WHERE job.status IN ('queued', 'leased')
         AND (job.snapshot_id = $1 OR (job.operation = 'create' AND sandbox.snapshot_id = $1))
       LIMIT 1`,
      [snapshotId],
    );
    if (activeUse.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "Wait for the active environment or prebuild operation to finish" }, 409);
    }
    await client.query(
      `UPDATE sandboxes SET prebuild_id = NULL
       WHERE organization_id = $2
         AND prebuild_id IN (SELECT id FROM project_prebuilds WHERE snapshot_id = $1 AND organization_id = $2)`,
      [snapshotId, workspace.organization_id],
    );
    await client.query(
      "DELETE FROM project_prebuilds WHERE snapshot_id = $1 AND organization_id = $2",
      [snapshotId, workspace.organization_id],
    );
    await client.query("DELETE FROM workspace_snapshots WHERE id = $1", [snapshotId]);
    await client.query("COMMIT");
    return c.json({ deleted: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listRegistries(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const result = await db.query(
    `SELECT id, name, url, username, created_at, last_used_at
     FROM workspace_registries WHERE organization_id = $1 ORDER BY created_at DESC`,
    [workspace.organization_id],
  );
  return c.json({ registries: result.rows });
}

export async function createRegistry(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = String(input?.name ?? "").trim();
  const url = String(input?.url ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  if (!name || name.length > 80) return c.json({ error: "Registry name is required" }, 400);
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(url) || url.length > 200)
    return c.json({ error: "Enter a valid registry host" }, 400);
  if (!username || username.length > 160) return c.json({ error: "Username is required" }, 400);
  if (!password || password.length > 8192) return c.json({ error: "Password or token is required" }, 400);
  const registryId = `reg_${crypto.randomUUID()}`;
  const encrypted = encryptSecret(password, secretContext.registry(workspace.organization_id, registryId));
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO workspace_registries
       (id, organization_id, name, url, username, encrypted_password, iv)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [registryId, workspace.organization_id, name, url, username, encrypted.encryptedValue, encrypted.iv],
    );
    return c.json({ id: result.rows[0]?.id }, 201);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "This registry is already connected" }, 409);
    throw error;
  }
}

export async function deleteRegistry(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const result = await db.query(
    "DELETE FROM workspace_registries WHERE id = $1 AND organization_id = $2",
    [c.req.param("id"), workspace.organization_id],
  );
  if (!result.rowCount) return c.json({ error: "Registry not found" }, 404);
  return c.json({ deleted: true });
}
