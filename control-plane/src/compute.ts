import { protectAgentSession, pollAgentSessions, reportAgentSession } from './agent-sessions.js';
import { connectionCredentials, signAgentCredentialGrant } from "./agent-connections.js";
import type { AgentConfiguration } from "./agent-config.js";
import { hasEnvironmentAccess } from "./environment-access.js";
import { isBillingError } from "./billing.js";
import { reportRuntimeProbe } from './runtime-recovery.js';
import { parseComputeHealth, dockerIsHealthy } from './compute-health.js';
import { bodyLimit } from "hono/body-limit";
import { pollExecutions, reportExecution } from "./executions.js";
import { githubToken } from "./github.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import { resourceCapacitySql } from "./resource-reservations.js";
import { authorizeEnvironmentStop, authorizeEnvironmentDelete, queueEnvironmentWake } from "./lifecycle.js";
import { decryptSecret, secretContext } from "./secrets.js";
import { verifyPreviewToken } from "./preview-token.js";
import { verifyTerminalToken } from "./terminal-token.js";
import type { AppEnv } from "./types.js";
import { parseSshTarget } from "./ssh-target.js";
import { createSshToken, verifySshToken } from "./ssh-token.js";
import { queueWebhookEvent } from "./webhook-events.js";

type ComputeJob = {
  id: string;
  sandbox_id: string;
  operation: "create" | "start" | "stop" | "delete" | "snapshot";
  status: "queued" | "leased" | "succeeded" | "failed";
  lease_owner: string | null;
  snapshot_id: string | null;
};

type Sandbox = {
  tailscale_configured: boolean;
  created_by_user_id: string;
  purpose: string;
  prebuild_id: string | null;
  repository_revision: string | null;
  initialization_command: string | null;
  repository: string | null;
  repository_branch: string | null;
  setup_command: string | null;
  startup_command: string | null;
  readiness_command: string | null;
  workspace_path: string | null;
  id: string;
  organization_id: string;
  name: string;
  runtime_id: string | null;
  source_type: "image" | "snapshot";
  source_image: string | null;
  snapshot_id: string | null;
  source_registry_id: string | null;
  cpu_count: number;
  memory_mb: number;
  disk_gb: number;
  code_trust: "trusted" | "untrusted";
};

const steps = new Set(["allocating", "restoring", "booting", "cloning", "setting-up", "initializing", "capturing-prebuild", "starting-services", "checking-app", "connecting", "ready"]);

function validToken(value: string): boolean {
  const expected = createHash("sha256").update(config.computeAgentToken).digest();
  const supplied = createHash("sha256").update(value).digest();
  return value.length > 0 && timingSafeEqual(expected, supplied);
}

function validGatewayToken(value: string): boolean {
  const expected = createHash("sha256").update(config.sshTokenSecret).digest();
  const supplied = createHash("sha256").update(value).digest();
  return value.length > 0 && timingSafeEqual(expected, supplied);
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  if (Number(c.req.header("content-length") ?? 0) > 131_072) return null;
  if (!c.req.header("content-type")?.includes("application/json")) return null;
  return c.req.json<Record<string, unknown>>().catch(() => null);
}

async function authenticateCompute(c: Context<AppEnv>, next: Next) {
  const authorization = c.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (validToken(token)) {
    c.set("computeAgent", { id: config.managedComputeNodeId, organizationId: null, managed: true });
    await next();
    return;
  }
  const result = await db.query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM compute_agents
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [createHash("sha256").update(token).digest("hex")],
  );
  const agent = result.rows[0];
  if (!token || !agent) return c.json({ error: "Compute agent authentication failed" }, 401);
  c.set("computeAgent", { id: agent.id, organizationId: agent.organization_id, managed: false });
  await db.query("UPDATE compute_agents SET last_seen_at = now(), updated_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '10 seconds')", [agent.id]);
  await next();
}

function computeAgentOwnsNode(c: Context<AppEnv>, nodeId: string): boolean {
  const authenticated = c.get("computeAgent");
  return authenticated.id === nodeId;
}

// Shared with the PostgreSQL queue regression test.
export const claimJobSql = `SELECT compute_jobs.id, compute_jobs.sandbox_id, compute_jobs.operation,
              compute_jobs.status, compute_jobs.lease_owner, compute_jobs.snapshot_id
       FROM compute_jobs
       JOIN sandboxes ON sandboxes.id = compute_jobs.sandbox_id
       JOIN organizations ON organizations.id = sandboxes.organization_id
       WHERE compute_jobs.runtime_class = 'container'
         AND ($3::text[] IS NULL OR compute_jobs.operation = ANY($3))
         AND ($4::boolean OR compute_jobs.operation <> 'create' OR
           (sandboxes.repository IS NULL AND sandboxes.setup_command IS NULL AND sandboxes.source_image IS DISTINCT FROM 'driftverk-dev:1'))
         AND ($9::boolean OR compute_jobs.operation NOT IN ('create', 'start') OR (sandboxes.purpose = 'development' AND sandboxes.prebuild_id IS NULL AND sandboxes.initialization_command IS NULL))
         AND ($8::boolean OR compute_jobs.operation NOT IN ('create', 'start') OR (sandboxes.startup_command IS NULL AND sandboxes.readiness_command IS NULL))
         AND (compute_jobs.operation <> 'create' OR sandboxes.snapshot_id IS NULL OR EXISTS (
           SELECT 1 FROM workspace_snapshots snapshot
           LEFT JOIN sandboxes source ON source.id = snapshot.source_sandbox_id
           WHERE snapshot.id = sandboxes.snapshot_id
             AND (source.compute_node_id = $2 OR (snapshot.artifact_ref LIKE 's3://%' AND
               ($1::text IS NULL OR (snapshot.storage_key IS NOT NULL AND snapshot.storage_key = $5))))
         ))
         AND (compute_jobs.status = 'queued' OR (compute_jobs.status = 'leased' AND compute_jobs.lease_expires_at < now()))
         AND (sandboxes.compute_node_id IS NULL OR sandboxes.compute_node_id = $2)
         AND (compute_jobs.operation NOT IN ('create', 'start') OR ${resourceCapacitySql("$2", "$6::int", "$7::int")})
         AND NOT EXISTS (
           SELECT 1 FROM sandbox_volume_mounts m JOIN workspace_volumes v ON v.id = m.volume_id
           WHERE m.sandbox_id = sandboxes.id AND v.compute_node_id IS NOT NULL AND v.compute_node_id <> $2
         )
         AND (
           ($1::text IS NULL AND organizations.hosting_mode = 'managed')
           OR ($1::text IS NOT NULL
             AND sandboxes.organization_id = $1 AND organizations.hosting_mode = 'hybrid')
         )
       ORDER BY compute_jobs.created_at ASC
       FOR UPDATE OF compute_jobs SKIP LOCKED
       LIMIT 1`;

async function claim(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(nodeId))
    return c.json({ error: "A valid node_id is required" }, 400);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const authenticated = c.get("computeAgent");
  const requestedOperations = payload?.operations === undefined ? null : payload.operations;
  if (payload?.accepting_jobs === false) return c.body(null, 204);
  const storageKey = typeof payload?.snapshot_storage_key === "string" && /^[a-f0-9]{64}$/.test(payload.snapshot_storage_key) ? payload.snapshot_storage_key : null;
  const capacity = payload?.capacity as { cpu_count?: unknown; memory_mb?: unknown } | undefined;
  const hostCpu = typeof capacity?.cpu_count === "number" && Number.isInteger(capacity.cpu_count) && capacity.cpu_count > 0 && capacity.cpu_count <= 65536 ? capacity.cpu_count : null;
  const hostMemory = typeof capacity?.memory_mb === "number" && Number.isInteger(capacity.memory_mb) && capacity.memory_mb > 0 && capacity.memory_mb <= 2147483647 ? capacity.memory_mb : null;
  if (requestedOperations !== null && (!Array.isArray(requestedOperations) || !requestedOperations.length || requestedOperations.length > 5 ||
      !requestedOperations.every((operation) => ["create", "start", "stop", "delete", "snapshot"].includes(operation))))
    return c.json({ error: "Invalid compute operations filter" }, 400);
  let operations = requestedOperations as string[] | null;
  if (payload?.health) {
    const report = parseComputeHealth(payload.health);
    if (!report) return c.json({ error: 'Invalid health report' }, 400);
    if (report.status !== 'healthy') {
      operations = dockerIsHealthy(report) ? (operations ?? ['stop', 'delete']).filter(op => ['stop', 'delete'].includes(op)) : [];
      if (!operations.length) return c.body(null, 204);
    }
  }
  if (!authenticated.managed) {
    const version = typeof payload?.version === "string" ? payload.version.trim().slice(0, 80) : null;
    const storageDriver = payload?.storage_driver === "local" || payload?.storage_driver === "s3" ? payload.storage_driver : null;
    await db.query(
      "UPDATE compute_agents SET last_seen_at = now(), version = $1, storage_driver = $2, snapshot_storage_key = $4, updated_at = now() WHERE id = $3 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '10 seconds' OR version IS DISTINCT FROM $1 OR storage_driver IS DISTINCT FROM $2 OR snapshot_storage_key IS DISTINCT FROM $4)",
      [version, storageDriver, authenticated.id, storageKey],
    );
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!authenticated.managed) {
      const active = await client.query("SELECT id, health, health_checked_at > now() - interval '60 seconds' AS health_fresh FROM compute_agents WHERE id = $1 AND revoked_at IS NULL FOR UPDATE", [nodeId]);
      if (!active.rowCount) { await client.query("ROLLBACK"); return c.json({ error: "Compute host has been removed" }, 403); }
      if (active.rows[0].health && (active.rows[0].health.status !== 'healthy' || !active.rows[0].health_fresh)) {
        const dockerHealthy = active.rows[0].health_fresh && dockerIsHealthy(active.rows[0].health);
        operations = dockerHealthy ? (operations ?? ['stop', 'delete']).filter((op: string) => ['stop', 'delete'].includes(op)) : [];
        if (!operations.length) { await client.query('ROLLBACK'); return c.body(null, 204); }
      }
      await client.query("UPDATE compute_agents SET cpu_count = $1, memory_mb = $2 WHERE id = $3 AND (cpu_count IS DISTINCT FROM $1 OR memory_mb IS DISTINCT FROM $2)", [hostCpu, hostMemory, nodeId]);
    }
    const claimed = await client.query<ComputeJob>(
      claimJobSql,
      [authenticated.organizationId, nodeId, operations, Array.isArray(payload?.capabilities) && payload.capabilities.includes("development-setup-v1"), storageKey, hostCpu, hostMemory, Array.isArray(payload?.capabilities) && payload.capabilities.includes("project-readiness-v1"), Array.isArray(payload?.capabilities) && payload.capabilities.includes("prebuilds-v1")],
    );
    const job = claimed.rows[0];
    if (job?.id.startsWith('recovery_') && !(Array.isArray(payload?.capabilities) && payload.capabilities.includes('runtime-recovery-v1'))) {
      await client.query('ROLLBACK');
      return c.body(null, 204);
    }
    if (!job) {
      await client.query("COMMIT");
      return c.body(null, 204);
    }
    await client.query("SELECT id FROM sandboxes WHERE id=$1 FOR UPDATE", [job.sandbox_id]);
    const volumeOwners = await client.query<{ id: string; compute_node_id: string | null }>(
      `SELECT v.id, v.compute_node_id FROM workspace_volumes v JOIN sandbox_volume_mounts m ON m.volume_id = v.id
       WHERE m.sandbox_id = $1 ORDER BY v.id FOR UPDATE OF v`, [job.sandbox_id]);
    if (volumeOwners.rows.some(volume => volume.compute_node_id && volume.compute_node_id !== nodeId)) {
      await client.query("ROLLBACK"); return c.body(null, 204);
    }
    if (volumeOwners.rowCount) await client.query("UPDATE workspace_volumes SET compute_node_id = $1 WHERE id = ANY($2::text[]) AND compute_node_id IS NULL", [nodeId, volumeOwners.rows.map(volume => volume.id)]);
    await client.query("SAVEPOINT billing_claim");
    try {
      await client.query(
        `UPDATE compute_jobs
         SET status = 'leased', lease_owner = $1, lease_expires_at = now() + interval '60 seconds',
             attempts = attempts + 1, updated_at = now()
         WHERE id = $2`,
        [nodeId, job.id],
      );
      await client.query("RELEASE SAVEPOINT billing_claim");
    } catch (error) {
      if (!isBillingError(error)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT billing_claim");
      await client.query("UPDATE compute_jobs SET status='failed',error_message=$1,updated_at=now() WHERE id=$2", [error.message,job.id]);
      if (job.operation !== "snapshot") await client.query("UPDATE sandboxes SET state='degraded',desired_state='stopped',error_message=$1 WHERE id=$2", [error.message,job.sandbox_id]);
      if (job.snapshot_id) await client.query("UPDATE workspace_snapshots SET status='failed',error_message=$1 WHERE id=$2", [error.message,job.snapshot_id]);
      await client.query("COMMIT");
      return c.body(null,204);
    }
    const sandboxResult = await client.query<Sandbox>(
      `SELECT created_by_user_id, purpose, prebuild_id, repository_revision, initialization_command, id, organization_id, name, runtime_id, source_type, source_image, snapshot_id, source_registry_id,
              tailscale_configured, cpu_count, memory_mb, disk_gb, code_trust, repository, repository_branch, setup_command, startup_command, readiness_command, workspace_path
       FROM sandboxes WHERE id = $1`,
      [job.sandbox_id],
    );
    const sandbox = sandboxResult.rows[0];
    if (!sandbox) throw new Error("Compute job references a missing sandbox");
    await client.query(
      "UPDATE sandboxes SET compute_node_id = $1, updated_at = now() WHERE id = $2 AND compute_node_id IS NULL",
      [nodeId, sandbox.id],
    );
    let registry: { url: string; username: string; password: string } | null = null;
    let snapshot: { id: string; name: string; artifact_ref: string | null } | null = null;
    if (sandbox.snapshot_id || job.snapshot_id) {
      const snapshotResult = await client.query<{ id: string; name: string; artifact_ref: string | null }>(
        "SELECT id, name, artifact_ref FROM workspace_snapshots WHERE id = $1",
        [job.snapshot_id || sandbox.snapshot_id],
      );
      snapshot = snapshotResult.rows[0] ?? null;
    }
    if (sandbox.source_registry_id) {
      const registryResult = await client.query<{
        url: string;
        username: string;
        encrypted_password: string;
        iv: string;
      }>(
        `SELECT url, username, encrypted_password, iv
         FROM workspace_registries WHERE id = $1 AND organization_id = $2`,
        [sandbox.source_registry_id, sandbox.organization_id],
      );
      const stored = registryResult.rows[0];
      if (!stored) throw new Error("Sandbox references a missing registry");
      registry = {
        url: stored.url,
        username: stored.username,
        password: decryptSecret(stored.encrypted_password, stored.iv, secretContext.registry(sandbox.organization_id, sandbox.source_registry_id)),
      };
    }
    const variables = await client.query<{ name: string; encrypted_value: string; iv: string }>(
      "SELECT name, encrypted_value, iv FROM sandbox_environment_variables WHERE sandbox_id = $1",
      [sandbox.id],
    );
    const volumes = await client.query<{
      id: string;
      name: string;
      storage_prefix: string;
      mount_path: string;
      subpath: string;
      read_only: boolean;
    }>(
      `SELECT workspace_volumes.id, workspace_volumes.name, workspace_volumes.storage_prefix,
              sandbox_volume_mounts.mount_path, sandbox_volume_mounts.subpath, sandbox_volume_mounts.read_only
       FROM sandbox_volume_mounts
       JOIN workspace_volumes ON workspace_volumes.id = sandbox_volume_mounts.volume_id
       WHERE sandbox_volume_mounts.sandbox_id = $1 ORDER BY sandbox_volume_mounts.mount_path`,
      [sandbox.id],
    );
    await client.query("COMMIT");
    return c.json({
      job: { id: job.id, operation: job.operation, lease_seconds: 60, snapshot },
      sandbox: {
        runtime_recovery: job.id.startsWith('recovery_'),
        runtime_recovery_retry: job.status === 'leased',
        tailscale_configured: sandbox.tailscale_configured,
        purpose: sandbox.purpose,
        development: ["create", "start"].includes(job.operation) && sandbox.code_trust === "trusted" ? {
          prebuilt: Boolean(sandbox.prebuild_id), revision: sandbox.repository_revision, initialization_command: sandbox.initialization_command, repository: sandbox.repository, branch: sandbox.repository_branch, setup_command: sandbox.setup_command, startup_command: sandbox.startup_command, readiness_command: sandbox.readiness_command,
          workspace_path: sandbox.workspace_path,
          token: job.operation === "create" && sandbox.repository && !sandbox.prebuild_id ? await githubToken(sandbox.created_by_user_id, sandbox.organization_id) : null,
        } : null,
        id: sandbox.id,
        name: sandbox.name,
        runtime_class: "container",
        runtime_id: sandbox.runtime_id,
        source: {
          type: sandbox.source_type,
          image: sandbox.source_image || snapshot?.artifact_ref || null,
          snapshot_id: sandbox.snapshot_id,
          registry,
        },
        resources: {
          cpu: sandbox.cpu_count,
          memory_mb: sandbox.memory_mb,
          disk_gb: sandbox.disk_gb,
        },
        code_trust: sandbox.code_trust,
        snapshot_allowed: true,
        environment: sandbox.code_trust === "trusted" ? Object.fromEntries(variables.rows.map((variable) => [variable.name, decryptSecret(
          variable.encrypted_value,
          variable.iv,
          secretContext.environment(sandbox.organization_id, sandbox.id, variable.name),
        )])) : {},
        volumes: volumes.rows,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function report(c: Context<AppEnv>) {
  const payload = await body(c);
  if (!payload) return c.json({ error: "A JSON body is required" }, 400);
  const nodeId = typeof payload.node_id === "string" ? payload.node_id : "";
  const event = typeof payload.event === "string" ? payload.event : "";
  const jobId = c.req.param("id");
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ComputeJob>(
      "SELECT id, sandbox_id, operation, status, lease_owner, snapshot_id FROM compute_jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    const job = result.rows[0];
    if (!job) {
      await client.query("ROLLBACK");
      return c.json({ error: "Job not found" }, 404);
    }
    if (job.status === "succeeded" && (event === "succeeded" || (event === "stopping" && job.operation === "stop" || event === "deleting" && job.operation === "delete") && job.lease_owner === nodeId)) {
      await client.query("COMMIT");
      return c.json({ ok: true, ...(event === "stopping" ? { stop: false } : event === "deleting" ? { delete: false } : {}) });
    }
    if (job.status !== "leased" || !nodeId || job.lease_owner !== nodeId) {
      await client.query("ROLLBACK");
      return c.json({ error: "Job lease belongs to another node" }, 409);
    }
    if (event === "stopping" && job.operation === "stop") {
      const stop = await authorizeEnvironmentStop(client, job.id, job.sandbox_id);
      await client.query("COMMIT");
      return c.json({ ok: true, stop });
    }
    if (event === "deleting" && job.operation === "delete") {
      const allowed = await authorizeEnvironmentDelete(client, job.id, job.sandbox_id);
      await client.query("COMMIT");
      return c.json({ok:true,delete:allowed});
    }
    if (event === "heartbeat") {
      await client.query("UPDATE sandboxes SET billing_compute_active=true WHERE id=$1 AND billing_compute_active AND runtime_id IS NOT NULL AND state NOT IN ('stopped','deleted')", [job.sandbox_id]);
      await client.query(
        "UPDATE compute_jobs SET lease_expires_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1",
        [jobId],
      );
    } else if (event === "progress") {
      const step = typeof payload.step === "string" ? payload.step : "";
      if (!steps.has(step)) {
        await client.query("ROLLBACK");
        return c.json({ error: "Unknown step" }, 400);
      }
      await client.query(
        `UPDATE compute_jobs SET provisioning_step = $1,
          lease_expires_at = now() + interval '60 seconds', updated_at = now() WHERE id = $2`,
        [step, jobId],
      );
      await client.query(
        "UPDATE sandboxes SET provisioning_step = $1, compute_node_id = $2, runtime_id = COALESCE($4, runtime_id), billing_compute_active = CASE WHEN $4::text IS NOT NULL THEN true ELSE billing_compute_active END, updated_at = now() WHERE id = $3",
        [step, nodeId, job.sandbox_id, ["create", "start"].includes(job.operation) && typeof payload.runtime_id === "string" ? payload.runtime_id : null],
      );
      await client.query(
        `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
         VALUES ($1, $2, now(), 'info', $3) ON CONFLICT DO NOTHING`,
        [job.sandbox_id, `${job.id}:progress:${step}`, `Provisioning: ${step}.`],
      );
    } else if (event === "failed") {
      const webhookContextResult = await client.query<{ organization_id: string; name: string; purpose: string }>(
        "SELECT organization_id, name, purpose FROM sandboxes WHERE id = $1",
        [job.sandbox_id],
      );
      const webhookContext = webhookContextResult.rows[0];
      if (!webhookContext) throw new Error("Compute job references a missing sandbox");
      const message =
        typeof payload.error === "string"
          ? payload.error.trim().slice(0, 1000)
          : "Compute operation failed";
      await client.query(
        "UPDATE compute_jobs SET status = 'failed', error_message = $1, lease_expires_at = NULL, updated_at = now() WHERE id = $2",
        [message, jobId],
      );
      if (job.operation === "snapshot" && job.snapshot_id) {
        await client.query("UPDATE workspace_snapshots SET status = 'failed', error_message = $1 WHERE id = $2", [message, job.snapshot_id]);
        await queueWebhookEvent(client, webhookContext.organization_id, "snapshot.failed", {
          snapshot: { id: job.snapshot_id, status: "failed", error: message },
          environment: { id: job.sandbox_id, name: webhookContext.name },
        });
      }
      if (job.operation !== "snapshot") {
        await client.query(
          "UPDATE sandboxes SET state = 'degraded', error_message = $1, compute_node_id = $2, updated_at = now() WHERE id = $3",
          [message, nodeId, job.sandbox_id],
        );
        if (webhookContext.purpose === "development") await queueWebhookEvent(client, webhookContext.organization_id, "environment.degraded", {
          environment: { id: job.sandbox_id, name: webhookContext.name, state: "degraded", error: message },
        });
      }
      await client.query(
        `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
         VALUES ($1, $2, now(), 'error', $3) ON CONFLICT DO NOTHING`,
        [job.sandbox_id, `${job.id}:failed`, message],
      );
    } else if (event === "succeeded") {
      const webhookContextResult = await client.query<{ organization_id: string; name: string; purpose: string }>(
        "SELECT organization_id, name, purpose FROM sandboxes WHERE id = $1",
        [job.sandbox_id],
      );
      const webhookContext = webhookContextResult.rows[0];
      if (!webhookContext) throw new Error("Compute job references a missing sandbox");
      const runtimeId =
        typeof payload.runtime_id === "string" ? payload.runtime_id.slice(0, 200) : null;
      if ((job.operation === "create" || job.operation === "start") && !runtimeId) {
        await client.query("ROLLBACK");
        return c.json({ error: "runtime_id is required" }, 400);
      }
      await client.query(
        "UPDATE compute_jobs SET status = 'succeeded', provisioning_step = 'ready', lease_expires_at = NULL, updated_at = now() WHERE id = $1",
        [jobId],
      );
      if (job.operation === "snapshot") {
        const artifactRef = typeof payload.artifact_ref === "string" ? payload.artifact_ref.slice(0, 300) : "";
        const sizeGb = Number(payload.snapshot_size_gb ?? 0);
        if (!job.snapshot_id || !artifactRef) {
          await client.query("ROLLBACK");
          return c.json({ error: "artifact_ref is required" }, 400);
        }
        await client.query(
          "UPDATE workspace_snapshots SET status = 'ready', artifact_ref = $1, snapshot_size_gb = $2, error_message = NULL, storage_key = (SELECT snapshot_storage_key FROM compute_agents WHERE id = (SELECT compute_node_id FROM sandboxes WHERE id = workspace_snapshots.source_sandbox_id)) WHERE id = $3",
          [artifactRef, Number.isFinite(sizeGb) ? sizeGb : 0, job.snapshot_id],
        );
        await queueWebhookEvent(client, webhookContext.organization_id, "snapshot.ready", {
          snapshot: { id: job.snapshot_id, status: "ready", artifact_ref: artifactRef, size_gb: Number.isFinite(sizeGb) ? sizeGb : 0 },
          environment: { id: job.sandbox_id, name: webhookContext.name },
        });
      } else if (job.operation === "delete") {
        await client.query("UPDATE sandbox_executions SET status = 'cancelled', cancel_requested = true, updated_at = now() WHERE sandbox_id = $1 AND status IN ('queued','running')", [job.sandbox_id]);
        await client.query(
          "UPDATE sandboxes SET state = 'deleted', desired_state = 'deleted', runtime_id = NULL, updated_at = now() WHERE id = $1",
          [job.sandbox_id],
        );
        if (webhookContext.purpose === "development") await queueWebhookEvent(client, webhookContext.organization_id, "environment.deleted", {
          environment: { id: job.sandbox_id, name: webhookContext.name, state: "deleted" },
        });
      } else if (job.operation === "stop") {
        await client.query(
          "UPDATE sandboxes SET state = 'stopped', desired_state = 'stopped', provisioning_step = 'ready', compute_node_id = $1, error_message = NULL, updated_at = now() WHERE id = $2",
          [nodeId, job.sandbox_id],
        );
        if (webhookContext.purpose === "development") await queueWebhookEvent(client, webhookContext.organization_id, "environment.stopped", {
          environment: { id: job.sandbox_id, name: webhookContext.name, state: "stopped" },
        });
      } else {
        await client.query(
          "UPDATE sandboxes SET state = 'running', desired_state = 'running', billing_compute_active = true, runtime_id = $1, provisioning_step = 'ready', compute_node_id = $2, error_message = NULL, updated_at = now() WHERE id = $3",
          [runtimeId, nodeId, job.sandbox_id],
        );
        if (webhookContext.purpose === "development") await queueWebhookEvent(client, webhookContext.organization_id, "environment.running", {
          environment: { id: job.sandbox_id, name: webhookContext.name, state: "running" },
        });
      }
      await client.query(
        `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
         VALUES ($1, $2, now(), 'info', $3) ON CONFLICT DO NOTHING`,
        [job.sandbox_id, `${job.id}:succeeded`, `Environment ${job.operation} succeeded.`],
      );
    } else {
      await client.query("ROLLBACK");
      return c.json({ error: "Unknown event" }, 400);
    }
    if (event === "succeeded" || event === "failed") {
      const prebuild = await client.query("SELECT id, snapshot_id FROM project_prebuilds WHERE sandbox_id = $1 AND status = 'building' FOR UPDATE", [job.sandbox_id]);
      if (prebuild.rowCount) {
        const row = prebuild.rows[0];
        if (event === "succeeded") {
          if (typeof payload.artifact_ref !== "string" || !payload.artifact_ref) throw new Error("Prebuild snapshot artifact is required");
          await client.query("UPDATE workspace_snapshots SET status = 'ready', artifact_ref = $1, snapshot_size_gb = $2, storage_key = (SELECT snapshot_storage_key FROM compute_agents WHERE id = $3) WHERE id = $4", [payload.artifact_ref, Number(payload.snapshot_size_gb) || 0, nodeId, row.snapshot_id]);
          await client.query("UPDATE project_prebuilds SET status = 'ready', completed_at = now() WHERE id = $1", [row.id]);
          await client.query("UPDATE sandboxes SET state = 'deleted', desired_state = 'deleted', runtime_id = NULL WHERE id = $1", [job.sandbox_id]);
        } else {
          await client.query("UPDATE project_prebuilds SET status = 'failed', error_message = $1, completed_at = now() WHERE id = $2", [String(payload.error || "Build failed").slice(0,1000), row.id]);
          await client.query("UPDATE workspace_snapshots SET status = 'failed' WHERE id = $1", [row.snapshot_id]);
          // Retain the failed prebuild for diagnosis, but retry builder cleanup through the leased job queue.
          await client.query("UPDATE sandboxes SET state = 'provisioning', desired_state = 'deleted' WHERE id = $1", [job.sandbox_id]);
          await client.query("INSERT INTO compute_jobs (id,sandbox_id,operation,status,provisioning_step) VALUES ($1,$2,'delete','queued','allocating')", [`job_${crypto.randomUUID()}`,job.sandbox_id]);
        }
      }
    }
    await client.query("COMMIT");
    return c.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function telemetry(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id : "";
  const samples = Array.isArray(payload?.samples) ? payload.samples.slice(0, 100) : [];
  if (!nodeId) return c.json({ error: "node_id is required" }, 400);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const volume of (Array.isArray(payload?.volume_sizes) ? payload.volume_sizes.slice(0,100) : [])) {
      if (!volume || typeof volume.id !== "string" || typeof volume.size_gb !== "number" || !Number.isFinite(volume.size_gb) || volume.size_gb<0 || volume.size_gb>1e9) continue;
      await client.query("UPDATE workspace_volumes SET billing_size_gb=$1 WHERE id=$2 AND compute_node_id=$3", [volume.size_gb,volume.id,nodeId]);
    }
    for (const raw of samples) {
      if (!raw || typeof raw !== "object") continue;
      const sample = raw as Record<string, unknown>;
      const sandboxId = String(sample.sandbox_id ?? "");
      const owned = await client.query("SELECT 1 FROM sandboxes WHERE id = $1 AND compute_node_id = $2", [sandboxId, nodeId]);
      if (!owned.rowCount) continue;
      await reportRuntimeProbe(client, nodeId, sandboxId, sample.runtime_id, sample.runtime_probe);
      await client.query("UPDATE sandboxes SET billing_compute_active=true WHERE id=$1 AND runtime_id IS NOT NULL AND state NOT IN ('stopped','deleted')", [sandboxId]);
      if (sample.application === null) {
        await client.query("UPDATE sandboxes SET application_status=NULL, application_status_at=now() WHERE id=$1", [sandboxId]);
      } else if (sample.application && typeof sample.application === "object") {
        const application = sample.application as Record<string, unknown>;
        if (["starting", "ready", "failed"].includes(String(application.status)) && Array.isArray(application.services)) {
          const services = application.services.slice(0, 100).filter(service => service && typeof service === "object").map(service => ({
            name: String(service.name ?? "").slice(0, 100), state: String(service.state ?? "").slice(0, 30),
            health: String(service.health ?? "").slice(0, 30), exit_code: Number.isInteger(service.exit_code) ? service.exit_code : null,
          }));
          await client.query("UPDATE sandboxes SET application_status=$2::jsonb, application_status_at=now() WHERE id=$1", [sandboxId, JSON.stringify({status: application.status, message: String(application.message ?? "").slice(0, 300), services})]);
        }
      }
      // Runtime CPU and I/O are metrics, not evidence of external access.
      const metric = sample.metric && typeof sample.metric === "object" ? sample.metric as Record<string, unknown> : null;
      if (metric) {
        const values = [metric.cpu_percent, metric.memory_usage_mb, metric.memory_percent, metric.filesystem_percent].map(Number);
        if (values.every(Number.isFinite)) await client.query(
          `INSERT INTO sandbox_metrics (sandbox_id, cpu_percent, memory_usage_mb, memory_percent, filesystem_percent)
           VALUES ($1, $2, $3, $4, $5)`, [sandboxId, ...values],
        );
      }
      const logs = Array.isArray(sample.logs) ? sample.logs.slice(-100) : [];
      for (const rawLine of logs) {
        const line = String(rawLine).slice(0, 8192);
        const match = line.match(/^(\S+)\s(.*)$/s);
        const timestampValue = match?.[1];
        const hasTimestamp = Boolean(timestampValue && !Number.isNaN(Date.parse(timestampValue)));
        const timestamp = hasTimestamp ? new Date(timestampValue!) : new Date();
        const message = (hasTimestamp ? (match?.[2] ?? line) : line).trim();
        if (!message) continue;
        const eventHash = createHash("sha256").update(line).digest("hex");
        await client.query(
          `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [sandboxId, eventHash, timestamp, /error|fatal|panic/i.test(message) ? "error" : "info", message],
        );
      }
      const ports = Array.isArray(sample.ports) ? [...new Set(sample.ports.map(Number))].slice(0, 200) : [];
      for (const port of ports) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        await client.query(
          `INSERT INTO sandbox_ports (sandbox_id, port) VALUES ($1, $2)
           ON CONFLICT (sandbox_id, port) DO UPDATE SET last_seen_at = now()`,
          [sandboxId, port],
        );
      }
    }
    await client.query("DELETE FROM sandbox_metrics WHERE recorded_at < now() - interval '24 hours'");
    await client.query("DELETE FROM sandbox_logs WHERE recorded_at < now() - interval '7 days'");
    await client.query("COMMIT");
    return c.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function resolvePreview(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  const previewId = typeof payload?.preview_id === "string" ? payload.preview_id.trim() : "";
  const token = typeof payload?.token === "string" ? payload.token : "";
  const port = Number(payload?.port);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const grant = verifyPreviewToken(token, config.previewTokenSecret);
  if (!nodeId || !previewId || !grant || grant.nodeId !== nodeId || grant.port !== port) return c.json({ error: "Preview access denied" }, 403);
  if (grant.userId && !await hasEnvironmentAccess(grant.sandboxId, grant.userId)) return c.json({ error: "Preview access denied" }, 403);
  const result = await db.query<{ id: string; runtime_id: string | null; state: string; desired_state: string }>(
    `SELECT id, runtime_id, state, desired_state FROM sandboxes
     WHERE id = $1 AND preview_id = $2 AND compute_node_id = $3
       AND preview_enabled = true AND state <> 'deleted' AND desired_state <> 'deleted'`,
    [grant.sandboxId, previewId, nodeId],
  );
  const environment = result.rows[0];
  if (!environment) return c.json({ error: "Preview target is unavailable" }, 404);
  if (environment.state !== "running" || environment.desired_state !== "running" || !environment.runtime_id) {
    const wake = await queueEnvironmentWake(environment.id, nodeId);
    if (wake.status === "stopped") return c.json({ error: "Environment was stopped manually. Start it from the web interface or run driftverk start <environment>." }, 409);
    if (wake.status === "starting") return c.json(wake, 202);
    if (wake.status !== "running") return c.json({ error: "Preview target could not start. Check its lifecycle logs." }, 409);
    // Re-resolve on the next request rather than returning a stale runtime ID.
    return c.json({ status: "starting" }, 202);
  }
  await db.query(
    `UPDATE sandboxes SET last_activity_at = now()
     WHERE id = $1 AND compute_node_id = $2 AND state <> 'deleted' AND desired_state <> 'deleted'`,
    [environment.id, nodeId],
  );
  await db.query("SELECT billing_access(organization_id,id,true) FROM sandboxes WHERE id=$1", [environment.id]);
  return c.json({ sandbox_id: environment.id, runtime_id: environment.runtime_id, port });
}

async function resolveTerminal(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const grant = verifyTerminalToken(token, config.terminalTokenSecret);
  if (!nodeId || !grant || grant.nodeId !== nodeId) return c.json({ error: "Terminal access denied" }, 403);
  if (!grant.userId || !await hasEnvironmentAccess(grant.sandboxId, grant.userId)) return c.json({ error: "Terminal access denied" }, 403);
  if (grant.agent && (payload?.agent_sessions !== true || payload?.agent_protection !== true)) return c.json({ error: "Update this compute host to open agent sessions" }, 409);
  const result = await db.query<{ id: string; organization_id: string; runtime_id: string; code_trust: "trusted" | "untrusted"; agent_configuration: AgentConfiguration | null; workspace_path: string | null }>(
    `SELECT id, organization_id, runtime_id, code_trust, agent_configuration, workspace_path FROM sandboxes
     WHERE id = $1 AND compute_node_id = $2 AND purpose = 'development' AND (state = 'running' OR (state = 'degraded' AND provisioning_step IN ('cloning', 'setting-up', 'initializing', 'starting-services', 'checking-app'))) AND desired_state = 'running' AND runtime_id IS NOT NULL`,
    [grant.sandboxId, nodeId],
  );
  const environment = result.rows[0];
  if (!environment) {
    const wake = await queueEnvironmentWake(grant.sandboxId, nodeId);
    if (wake.status === "stopped") return c.json({ error: "Environment was stopped manually. Start it from the web interface or run driftverk start <environment>." }, 409);
    if (wake.status !== "unavailable") return c.json({ ...wake, status: "starting" }, 202);
    return c.json({ error: "Terminal target could not start. Check its lifecycle logs." }, 409);
  }
  if (grant.agent && (environment.code_trust !== "trusted" || !environment.agent_configuration)) return c.json({ error: "This environment has no configured agent" }, 409);
  await db.query("SELECT billing_access($1,$2)", [environment.organization_id,environment.id]);
  await db.query(
    `UPDATE sandboxes SET last_activity_at = now()
     WHERE id = $1 AND compute_node_id = $2 AND purpose = 'development' AND state <> 'deleted' AND desired_state <> 'deleted'`,
    [environment.id, nodeId],
  );
  const variables = await db.query<{ name: string; encrypted_value: string; iv: string }>(
    "SELECT name, encrypted_value, iv FROM sandbox_environment_variables WHERE sandbox_id = $1",
    [environment.id],
  );
  let managedConnection: { url: string; token: string; account_id: string } | undefined;
  if (grant.agent && environment.agent_configuration?.connection_id) {
    if (payload?.agent_credentials !== true) return c.json({ error: "Update this compute host to use connected accounts" }, 409);
    const connectionId = environment.agent_configuration.connection_id;
    try {
      const credentials = await connectionCredentials(connectionId, grant.userId);
      managedConnection = {
        url: `${config.betterAuthUrl.replace(/\/$/, "")}/api/agent-credentials/codex`,
        account_id: credentials.accountId,
        token: signAgentCredentialGrant({ sandboxId: environment.id, nodeId, userId: grant.userId,
          connectionId, runtimeId: environment.runtime_id, accountId: credentials.accountId, generation: credentials.generation,
          expiresAt: Date.now() + 24 * 60 * 60_000, nonce: crypto.randomUUID() }),
      };
    } catch { return c.json({ error: "Open Agents and reconnect your ChatGPT account" }, 409); }
  }
  let protection;
  if (grant.agent) {
    try { protection = await protectAgentSession(environment.id, environment.runtime_id, nodeId, JSON.stringify({user:grant.userId,agent:environment.agent_configuration,account:managedConnection?.account_id})); }
    catch(error) { return c.json({error: error instanceof Error && error.message.startsWith('An agent session') ? error.message : 'Wait until the environment is ready with no lifecycle operation in progress'},409); }
  }
  return c.json({
    agent_connection: managedConnection,
    agent: grant.agent ? { ...environment.agent_configuration, protection, workspace_path: environment.workspace_path || "/workspace" } : undefined,
    sandbox_id: environment.id,
    runtime_id: environment.runtime_id,
    environment: environment.code_trust === "trusted" ? Object.fromEntries(variables.rows.map((variable) => [variable.name, decryptSecret(
      variable.encrypted_value,
      variable.iv,
      secretContext.environment(environment.organization_id, environment.id, variable.name),
    )])) : {},
  });
}

async function authorizeSsh(c: Context<AppEnv>) {
  const payload = await body(c);
  const target = parseSshTarget(payload?.target);
  const fingerprint = typeof payload?.fingerprint === "string" ? payload.fingerprint.trim() : "";
  if (!target || !/^SHA256:[A-Za-z0-9+/]{20,100}$/.test(fingerprint))
    return c.json({ error: "Invalid SSH authorization request" }, 400);
  const result = await db.query<{ sandbox_id: string; compute_node_id: string; user_id: string }>(
    `SELECT DISTINCT sandboxes.id AS sandbox_id, sandboxes.compute_node_id, memberships.user_id
     FROM sandboxes
     JOIN organizations ON organizations.id = sandboxes.organization_id
     JOIN memberships ON memberships.organization_id = sandboxes.organization_id
     JOIN user_ssh_keys ON user_ssh_keys.user_id = memberships.user_id
     WHERE ($1::text IS NULL OR organizations.slug = $1) AND sandboxes.name = $2
       AND sandboxes.purpose = 'development' AND sandboxes.state <> 'deleted' AND sandboxes.compute_node_id IS NOT NULL
       AND user_ssh_keys.fingerprint = $3 AND sandboxes.ssh_enabled
       AND can_access_environment(sandboxes.id, memberships.user_id)
     LIMIT 2`,
    [target.organizationSlug, target.environmentName, fingerprint],
  );
  if (result.rows.length > 1)
    return c.json({ error: `More than one accessible environment is named ${target.environmentName}. Use organization.${target.environmentName}.` }, 409);
  const authorized = result.rows[0];
  if (!authorized) return c.json({ error: "SSH access denied" }, 403);
  await db.query("SELECT billing_access(organization_id,id) FROM sandboxes WHERE id=$1", [authorized.sandbox_id]);
  const expiresAt = Date.now() + 60_000;
  return c.json({
    sandbox_id: authorized.sandbox_id,
    node_id: authorized.compute_node_id,
    ticket: createSshToken({ userId: authorized.user_id, fingerprint, sandboxId: authorized.sandbox_id, nodeId: authorized.compute_node_id, expiresAt, nonce: crypto.randomUUID() }, config.sshTokenSecret),
    expires_at: new Date(expiresAt).toISOString(),
  });
}

async function resolveSsh(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  const ticket = typeof payload?.ticket === "string" ? payload.ticket : "";
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const grant = verifySshToken(ticket, config.sshTokenSecret);
  if (!grant || grant.nodeId !== nodeId) return c.json({ error: "SSH session denied" }, 403);
  if (!grant.userId || !grant.fingerprint || !await hasEnvironmentAccess(grant.sandboxId, grant.userId)) return c.json({ error: "SSH access denied" }, 403);
  const key = await db.query("SELECT 1 FROM user_ssh_keys WHERE user_id=$1 AND fingerprint=$2", [grant.userId, grant.fingerprint]);
  if (!key.rowCount) return c.json({ error: "SSH access denied" }, 403);
  // Recheck before waking a stopped environment, including tickets issued before revocation.
  const access = await db.query("SELECT 1 FROM sandboxes WHERE id=$1 AND compute_node_id=$2 AND ssh_enabled AND purpose='development' AND state<>'deleted' AND desired_state<>'deleted'", [grant.sandboxId, nodeId]);
  if (!access.rowCount) return c.json({ error: "SSH access denied" }, 403);
  const result = await db.query<{ sandbox_id: string; organization_id: string; runtime_id: string; code_trust: "trusted" | "untrusted" }>(
    `SELECT id AS sandbox_id, organization_id, runtime_id, code_trust FROM sandboxes
     WHERE id = $1 AND compute_node_id = $2 AND ssh_enabled AND state = 'running' AND desired_state = 'running' AND runtime_id IS NOT NULL`,
    [grant.sandboxId, nodeId],
  );
  const authorized = result.rows[0];
  if (!authorized) {
    const wake = await queueEnvironmentWake(grant.sandboxId, nodeId);
    if (wake.status === "stopped") return c.json({ error: "Environment was stopped manually. Start it from the web interface or run driftverk start <environment>." }, 409);
    if (wake.status !== "unavailable") return c.json({ ...wake, status: "starting" }, 202);
    return c.json({ error: "SSH target could not start. Check its lifecycle logs." }, 409);
  }
  await db.query("SELECT billing_access($1,$2)", [authorized.organization_id,authorized.sandbox_id]);
  await db.query(
    `UPDATE sandboxes SET last_activity_at = now()
     WHERE id = $1 AND compute_node_id = $2 AND state <> 'deleted' AND desired_state <> 'deleted'`,
    [authorized.sandbox_id, nodeId],
  );
  const variables = await db.query<{ name: string; encrypted_value: string; iv: string }>(
    "SELECT name, encrypted_value, iv FROM sandbox_environment_variables WHERE sandbox_id = $1",
    [authorized.sandbox_id],
  );
  return c.json({
    ...authorized,
    environment: authorized.code_trust === "trusted" ? Object.fromEntries(variables.rows.map((variable) => [variable.name, decryptSecret(
      variable.encrypted_value,
      variable.iv,
      secretContext.environment(authorized.organization_id, authorized.sandbox_id, variable.name),
    )])) : {},
  });
}

async function recordAccessActivity(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id : "";
  const sandboxId = typeof payload?.sandbox_id === "string" ? payload.sandbox_id : "";
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const result = await db.query(
    `UPDATE sandboxes SET last_activity_at = now()
     WHERE id = $1 AND compute_node_id = $2 AND (state = 'running' AND desired_state = 'running' OR
       state = 'provisioning' AND desired_state = 'stopped' AND EXISTS (
         SELECT 1 FROM compute_jobs j WHERE j.auto_stop AND j.sandbox_id = sandboxes.id AND j.status IN ('queued','leased') AND j.provisioning_step <> 'stopping'))`,
    [sandboxId, nodeId],
  );
  return result.rowCount ? c.json({ ok: true }) : c.json({ error: "Environment not available" }, 404);
}

async function sshEvent(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  const sandboxId = typeof payload?.sandbox_id === "string" ? payload.sandbox_id : "";
  const event = typeof payload?.event === "string" ? payload.event : "";
  const allowedEvents = new Set(["connected", "disconnected", "authentication_failed"]);
  if (!nodeId || !sandboxId || !allowedEvents.has(event)) return c.json({ error: "Invalid SSH event" }, 400);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const owned = await db.query("SELECT 1 FROM sandboxes WHERE id = $1 AND compute_node_id = $2", [sandboxId, nodeId]);
  if (!owned.rowCount) return c.json({ error: "Environment not found" }, 404);
  if (event === "connected") {
    await db.query(
      `UPDATE sandboxes SET last_activity_at = now()
       WHERE id = $1 AND compute_node_id = $2 AND state = 'running' AND desired_state = 'running'`,
      [sandboxId, nodeId],
    );
  }
  const message = event === "connected" ? "SSH session connected." : event === "disconnected" ? "SSH session disconnected." : "SSH authentication failed.";
  await db.query(
    `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
     VALUES ($1, $2, now(), $3, $4)`,
    [sandboxId, `ssh:${crypto.randomUUID()}`, event === "authentication_failed" ? "error" : "info", message],
  );
  return c.json({ ok: true });
}

async function assignedVolumes(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(nodeId)) return c.json({ error: "A valid node_id is required" }, 400);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const result = await db.query<{ id: string; storage_prefix: string; subpath: string }>(
    `SELECT DISTINCT workspace_volumes.id, workspace_volumes.storage_prefix, sandbox_volume_mounts.subpath
     FROM workspace_volumes
     JOIN sandbox_volume_mounts ON sandbox_volume_mounts.volume_id = workspace_volumes.id
     JOIN sandboxes ON sandboxes.id = sandbox_volume_mounts.sandbox_id
     WHERE sandboxes.compute_node_id = $1 AND sandboxes.purpose = 'development' AND sandboxes.state <> 'deleted'`,
    [nodeId],
  );
  const metered = await db.query("SELECT id FROM workspace_volumes WHERE compute_node_id=$1", [nodeId]);
  return c.json({ volumes: result.rows, metered_volumes: metered.rows });
}

async function protectedImages(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(nodeId)) return c.json({ error: "A valid node_id is required" }, 400);
  if (!computeAgentOwnsNode(c, nodeId)) return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  const organizationId = c.get("computeAgent").organizationId;
  const result = await db.query<{ snapshot_id: string }>(
    `SELECT DISTINCT snapshot_id
     FROM sandboxes
     WHERE compute_node_id = $1 AND ($2::text IS NULL OR organization_id = $2)
       AND state <> 'deleted' AND snapshot_id IS NOT NULL
     UNION
     SELECT id AS snapshot_id
     FROM workspace_snapshots
     WHERE ($2::text IS NULL OR organization_id = $2)
       AND status IN ('building', 'ready')
       AND (artifact_ref IS NULL OR artifact_ref NOT LIKE 's3://%')`,
    [nodeId, organizationId],
  );
  return c.json({ protected_snapshot_ids: result.rows.map((row) => row.snapshot_id) });
}

async function authorizeTunnel(c: Context<AppEnv>) {
  const payload = await body(c);
  const nodeId = typeof payload?.node_id === "string" ? payload.node_id.trim() : "";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(nodeId))
    return c.json({ error: "A valid node_id is required" }, 400);
  if (!computeAgentOwnsNode(c, nodeId))
    return c.json({ error: "Compute agent identity does not match node_id" }, 403);
  return c.json({ node_id: nodeId });
}

export function registerComputeRoutes(app: Hono<AppEnv>) {
  app.post("/api/gateway/ssh/authorize", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    if (!validGatewayToken(authorization.startsWith("Bearer ") ? authorization.slice(7) : ""))
      return c.json({ error: "Gateway authentication failed" }, 401);
    return authorizeSsh(c);
  });
  app.use("/api/compute/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/api/compute/*", authenticateCompute);
  app.post("/api/compute/jobs/claim", claim);
  app.post('/api/compute/health', async c => {
    const payload = await body(c);
    if (typeof payload?.node_id !== 'string' || !computeAgentOwnsNode(c, payload.node_id)) return c.json({ error: 'Compute agent identity does not match node_id' }, 403);
    const health = parseComputeHealth(payload?.health);
    if (!health) return c.json({ error: 'Invalid health report' }, 400);
    const agent = c.get('computeAgent');
    const version = typeof payload?.version === 'string' ? payload.version.trim().slice(0, 80) : null;
    if (!agent.managed) await db.query('UPDATE compute_agents SET health=$1::jsonb, health_checked_at=now(), last_seen_at=now(), version=COALESCE($3,version) WHERE id=$2', [JSON.stringify(health), agent.id, version]);
    return c.json({ ok: true });
  });
  app.post("/api/compute/agent-sessions/poll", pollAgentSessions);
  app.post("/api/compute/agent-sessions/:id/report", reportAgentSession);
  app.post("/api/compute/executions/poll", pollExecutions);
  app.post("/api/compute/executions/:id/report", bodyLimit({ maxSize: 900000 }), reportExecution);
  app.post("/api/compute/activity", recordAccessActivity);
  app.post("/api/compute/jobs/:id/events", report);
  app.post("/api/compute/telemetry", telemetry);
  app.post("/api/compute/volumes", assignedVolumes);
  app.post("/api/compute/images/protected", protectedImages);
  app.post("/api/compute/tunnel/authorize", authorizeTunnel);
  app.post("/api/compute/ssh/resolve", resolveSsh);
  app.post("/api/compute/ssh/events", sshEvent);
  app.post("/api/compute/preview/resolve", resolvePreview);
  app.post("/api/compute/terminal/resolve", resolveTerminal);
}
