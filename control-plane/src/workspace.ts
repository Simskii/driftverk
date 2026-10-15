import { memberPolicy, memberCreationInput } from "./member-self-service.js";
import { resolveAgentSetup } from "./agents.js";
import type { AgentConfiguration } from "./agent-config.js";
import { resolveOrganizationSecrets } from "./org-secrets.js";
import { resolveSnapshotConfiguration } from "./snapshot-configuration.js";
import { resolveSystemSnapshot } from "./system-snapshots.js";
import { resolvePrebuild } from "./prebuilds.js";
import { parseDevelopmentConfig, parsePreviewPort, parseOrganizationSecretNames } from "./development-config.js";
import { selectHost } from "./host-placement.js";
import { githubRequest, githubToken } from "./github.js";
import type { User } from "better-auth";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "./db.js";
import { queueReasonSql } from "./resource-reservations.js";
import { encryptSecret, secretContext } from "./secrets.js";
import { config } from "./config.js";
import type { AppEnv, AuthSession } from "./types.js";
import { queueWebhookEvent } from "./webhook-events.js";
import { parseVolumeMounts } from "./volume-mounts.js";
import { parseEnvironmentVariable } from "./environment-variables.js";

type Workspace = {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  role: "admin" | "member";
};

type Sandbox = {
  personal_owner_user_id: string | null;
  id: string;
  name: string;
  state: string;
  desired_state: string;
  code_trust: "trusted" | "untrusted";
  source_type: "image" | "snapshot";
  source_image: string | null;
  snapshot_id: string | null;
  cpu_count: number;
  memory_mb: number;
  disk_gb: number;
  runtime_id: string | null;
  compute_node_id: string | null;
  provisioning_step: string;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  auto_stop_minutes: number | null;
  auto_archive_minutes: number | null;
  auto_delete_minutes: number | null;
  ephemeral: boolean;
};

export async function workspaceFor(user: User, activeOrganizationId?: string | null): Promise<Workspace> {
  const existing = await db.query<Workspace>(
    `SELECT memberships.organization_id, organizations.name AS organization_name,
            organizations.slug AS organization_slug, memberships.role
     FROM memberships JOIN organizations ON organizations.id = memberships.organization_id
     WHERE memberships.user_id = $1 AND ($2::text IS NULL OR organizations.id = $2)
     ORDER BY memberships.created_at LIMIT 1`,
    [user.id, activeOrganizationId ?? null],
  );
  if (existing.rows[0]) return existing.rows[0];
  if (activeOrganizationId) throw new HTTPException(403, { message: "You are not a member of the selected organization" });

  throw new HTTPException(409, { message: "Create an organization before using Driftverk" });
}

const sandboxColumns = `(SELECT json_build_object('expires_at',p.expires_at,'lease_expires_at',p.lease_expires_at,'status',p.status) FROM agent_session_protections p WHERE p.sandbox_id=sandboxes.id AND p.runtime_id=sandboxes.runtime_id AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now()) AS agent_protection, personal_owner_user_id, agent_configuration, application_status, application_status_at, organization_secret_names, purpose, preview_port, preview_enabled, prebuild_id, repository_revision, initialization_command, repository, repository_branch, setup_command, startup_command, readiness_command, workspace_path, id, name, state, desired_state, source_type, source_image, snapshot_id, source_registry_id,
  ssh_enabled,
  (SELECT name FROM compute_agents WHERE id = sandboxes.compute_node_id) AS compute_host_name,
  cpu_count, memory_mb, disk_gb, runtime_id, compute_node_id, provisioning_step,
  error_message, created_at, updated_at, last_activity_at,
  auto_stop_minutes, auto_archive_minutes, auto_delete_minutes, ephemeral, code_trust, has_ever_received_environment_secrets,
  (SELECT operation FROM compute_jobs WHERE sandbox_id = sandboxes.id AND status IN ('queued', 'leased') LIMIT 1) AS active_operation,
  ${queueReasonSql} AS queue_reason`;

export async function listEnvironments(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const result = await db.query<Sandbox>(
    `SELECT ${sandboxColumns}
     FROM sandboxes WHERE organization_id = $1 AND purpose = 'development' AND state <> 'deleted'
       AND (preview_template_id IS NULL OR preview_claim_key IS NOT NULL)
       AND can_access_environment(id,$2) ORDER BY created_at DESC`,
    [workspace.organization_id, authSession.user.id],
  );
  return c.json({
    workspace: {
      id: workspace.organization_id,
      name: workspace.organization_name,
      role: workspace.role,
    },
    user: {
      id: authSession.user.id,
      name: authSession.user.name,
      email: authSession.user.email,
    },
    environments: result.rows,
  });
}

export async function getEnvironment(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const result = await db.query<Sandbox>(
    `SELECT ${sandboxColumns}
     FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted'`,
    [c.req.param("id"), workspace.organization_id],
  );
  const environment = result.rows[0];
  if (!environment) return c.json({ error: "Environment not found" }, 404);
  const variables = await db.query<{ name: string }>(
    "SELECT name FROM sandbox_environment_variables WHERE sandbox_id = $1 ORDER BY name",
    [environment.id],
  );
  const keyCount = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM user_ssh_keys
     WHERE user_id IN (SELECT user_id FROM memberships WHERE organization_id = $1 AND can_access_environment($2,user_id))`,
    [workspace.organization_id, environment.id],
  );
  const volumeMounts = await db.query<{
    volume_id: string;
    volume_name: string;
    mount_path: string;
    subpath: string;
    read_only: boolean;
  }>(
    `SELECT sandbox_volume_mounts.volume_id, workspace_volumes.name AS volume_name,
            sandbox_volume_mounts.mount_path, sandbox_volume_mounts.subpath, sandbox_volume_mounts.read_only
     FROM sandbox_volume_mounts
     JOIN workspace_volumes ON workspace_volumes.id = sandbox_volume_mounts.volume_id
     WHERE sandbox_volume_mounts.sandbox_id = $1 ORDER BY sandbox_volume_mounts.mount_path`,
    [environment.id],
  );
  return c.json({ environment: {
    ...environment,
    environment_variable_names: variables.rows.map((row) => row.name),
    can_manage_lifecycle: workspace.role === "admin",
    can_manage_actions: workspace.role === "admin" || environment.personal_owner_user_id === authSession.user.id,
    can_manage_configuration: workspace.role === "admin" && environment.code_trust === "trusted",
    ssh_host: config.sshPublicHost,
    ssh_port: config.sshPublicPort,
    ssh_username: `${workspace.organization_slug}.${environment.name}`,
    ssh_key_count: Number(keyCount.rows[0]?.count ?? 0),
    volume_mounts: volumeMounts.rows,
  } });
}

export async function getEnvironmentTelemetry(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const sandboxId = c.req.param("id");
  const exists = await db.query("SELECT 1 FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted'", [sandboxId, workspace.organization_id]);
  if (!exists.rowCount) return c.json({ error: "Environment not found" }, 404);
  const [metrics, logs, ports] = await Promise.all([
    db.query(`SELECT cpu_percent, memory_usage_mb, memory_percent, filesystem_percent, recorded_at
              FROM sandbox_metrics WHERE sandbox_id = $1 AND recorded_at > now() - interval '1 hour'
              ORDER BY recorded_at ASC LIMIT 240`, [sandboxId]),
    db.query(`SELECT recorded_at, severity, message FROM sandbox_logs
              WHERE sandbox_id = $1 ORDER BY recorded_at DESC LIMIT 200`, [sandboxId]),
    db.query(`SELECT port, protocol, first_seen_at, last_seen_at FROM sandbox_ports
              WHERE sandbox_id = $1 AND last_seen_at > now() - interval '90 seconds' ORDER BY port`, [sandboxId]),
  ]);
  return c.json({ metrics: metrics.rows, logs: logs.rows.reverse(), ports: ports.rows });
}

export async function createEnvironment(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin" && workspace.role !== "member") return c.json({ error: "Workspace access required" }, 403);
  const isMember = workspace.role === "member";

  let input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "Invalid JSON body" }, 400);
  const submittedInput = input;
  if (isMember) input = memberCreationInput(input, await memberPolicy(workspace.organization_id));
  let development;
  let organizationSecretNames: string[];
  try {
    input = await resolvePrebuild(workspace.organization_id, input);
    input = await resolveSystemSnapshot(input);
    input = await resolveSnapshotConfiguration(workspace.organization_id, input);
    development = parseDevelopmentConfig(input);
    organizationSecretNames = parseOrganizationSecretNames(input.organization_secret_names);
    if (input.code_trust === "untrusted" && organizationSecretNames.length) throw new Error("Untrusted code cannot receive organization secrets");
    parsePreviewPort(input.preview_port);
    if (development.repository && !input.prebuild_id) {
      const token = await githubToken(authSession.user.id, workspace.organization_id);
      const repo = await githubRequest(`/repos/${development.repository}`, token);
      development.repository_branch ||= repo.default_branch;
      await githubRequest(`/repos/${development.repository}/branches/${encodeURIComponent(development.repository_branch!)}`, token);
    }
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid repository setup" }, 400); }
  const requestedName = String(input.name ?? "").trim().toLowerCase();
  const name = requestedName || `env-${crypto.randomUUID().slice(0, 8)}`;
  const sourceType = input.source_type === "snapshot" ? "snapshot" : "image";
  const image = String(input.image ?? "").trim();
  const snapshotId = String(input.snapshot_id ?? "").trim();
  const registryId = String(input.registry_id ?? "").trim() || null;
  const cpu = Number(input.cpu ?? 1);
  const memoryMb = Number(input.memory_mb ?? 2048);
  const diskGb = Number(input.disk_gb ?? 40);
  const autoStopMinutes = optionalMinutes(input.auto_stop_minutes, 15);
  const autoArchiveMinutes = optionalMinutes(input.auto_archive_minutes, 10080);
  const autoDeleteMinutes = optionalMinutes(input.auto_delete_minutes, null);
  const ephemeral = input.ephemeral === true;
  const previewEnabled = input.preview_enabled !== false;
  const environmentVariables = Array.isArray(input.environment_variables) ? input.environment_variables : [];
  const parsedMounts = parseVolumeMounts(input.volume_mounts);
  if ("error" in parsedMounts) return c.json({ error: parsedMounts.error }, 400);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    return c.json({ error: "Invalid environment name" }, 400);
  if (sourceType === "image" && (!image || /\s|\.\./.test(image) || image.length > 240))
    return c.json({ error: "Invalid OCI image reference" }, 400);
  if (sourceType === "snapshot" && !snapshotId)
    return c.json({ error: "Select a snapshot" }, 400);
  if (![1, 2, 4, 8].includes(cpu)) return c.json({ error: "Invalid CPU count" }, 400);
  if (![1024, 2048, 4096, 8192, 16384].includes(memoryMb))
    return c.json({ error: "Invalid memory size" }, 400);
  if (![20, 40, 50, 80, 100].includes(diskGb))
    return c.json({ error: "Invalid disk size" }, 400);
  if (autoStopMinutes === undefined || autoArchiveMinutes === undefined || autoDeleteMinutes === undefined)
    return c.json({ error: "Lifecycle values must be whole minutes or disabled" }, 400);
  if (environmentVariables.length > 25) return c.json({ error: "Use at most 25 environment variables" }, 400);
  const parsedVariables: Array<{ name: string; value: string }> = [];
  const variableNames = new Set<string>();
  for (const item of environmentVariables) {
    if (!item || typeof item !== "object") return c.json({ error: "Invalid environment variable" }, 400);
    const variable = parseEnvironmentVariable(item);
    if (!variable || variableNames.has(variable.name))
      return c.json({ error: `Invalid or duplicate environment variable: ${variable?.name || "unnamed"}` }, 400);
    variableNames.add(variable.name);
    parsedVariables.push(variable);
  }

  const sandboxId = `dev_${crypto.randomUUID()}`;
  const previewId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID()}`;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let personalMembershipId: string | null = null;
    if (isMember) {
      const policy = await memberPolicy(workspace.organization_id, client, true);
      const membership = (await client.query("SELECT id, role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE", [workspace.organization_id, authSession.user.id])).rows[0];
      if (!membership || membership.role !== "member") throw new HTTPException(403, { message: "Workspace membership changed. Please try again." });
      memberCreationInput(submittedInput, policy);
      if (policy.image !== image || policy.cpu !== cpu || policy.memory_mb !== memoryMb)
        throw new HTTPException(409, { message: "Member environment defaults changed. Please try again." });
      const existing = await client.query("SELECT 1 FROM sandboxes WHERE organization_id=$1 AND personal_owner_user_id=$2 AND state<>'deleted'", [workspace.organization_id, authSession.user.id]);
      if (existing.rowCount) throw new HTTPException(409, { message: "You already have a personal environment. Delete it and wait for deletion to finish before creating another." });
      personalMembershipId = membership.id;
    }
    let agentConfiguration: AgentConfiguration | null = null;
    try {
      const agent = await resolveAgentSetup(workspace.organization_id, input.agent_id, input.code_trust !== "untrusted", organizationSecretNames, client, input.agent_auth_method, authSession.user.id);
      agentConfiguration = agent.configuration;
      parsedVariables.push(...await resolveOrganizationSecrets(workspace.organization_id, agent.secretNames, parsedVariables, client));
    }
    catch (error) { await client.query("ROLLBACK"); return c.json({ error: error instanceof Error ? error.message : "Could not resolve organization secrets" }, 400); }
    if (snapshotId) {
      const snapshot = await client.query(
        "SELECT 1 FROM workspace_snapshots WHERE id = $1 AND organization_id = $2 AND status = 'ready'",
        [snapshotId, workspace.organization_id],
      );
      if (!snapshot.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "Snapshot is not ready or does not exist" }, 400);
      }
    }
    if (registryId) {
      const registry = await client.query(
        "SELECT 1 FROM workspace_registries WHERE id = $1 AND organization_id = $2",
        [registryId, workspace.organization_id],
      );
      if (!registry.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "Registry does not exist" }, 400);
      }
    }
    if (parsedMounts.mounts.length) {
      const volumeIds = [...new Set(parsedMounts.mounts.map((mount) => mount.volumeId))];
      const volumes = await client.query<{ id: string }>(
        "SELECT id FROM workspace_volumes WHERE organization_id = $1 AND id = ANY($2::text[])",
        [workspace.organization_id, volumeIds],
      );
      if (volumes.rowCount !== volumeIds.length) {
        await client.query("ROLLBACK");
        return c.json({ error: "A selected volume does not exist in this workspace" }, 400);
      }
    }
    let computeNodeId: string | null;
    try { computeNodeId = await selectHost(client, workspace.organization_id, input.compute_node_id, sourceType === "snapshot" ? snapshotId : null); }
    catch (error) { await client.query("ROLLBACK"); return c.json({ error: error instanceof Error ? error.message : "Could not select a compute host" }, 400); }
    if (parsedMounts.mounts.length) {
      const mounted = await client.query<{ compute_node_id: string | null }>("SELECT compute_node_id FROM workspace_volumes WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE", [parsedMounts.mounts.map(mount => mount.volumeId)]);
      const owners = new Set(mounted.rows.map(row => row.compute_node_id).filter((id): id is string => Boolean(id)));
      if (owners.size > 1 || (computeNodeId && owners.size && !owners.has(computeNodeId))) {
        await client.query("ROLLBACK"); return c.json({ error: "These volumes belong to a different compute host" }, 400);
      }
      computeNodeId ||= [...owners][0] ?? null;
      if (computeNodeId) await client.query("UPDATE workspace_volumes SET compute_node_id = $1 WHERE id = ANY($2::text[]) AND compute_node_id IS NULL", [computeNodeId, parsedMounts.mounts.map(mount => mount.volumeId)]);
    }
    await client.query(
      `INSERT INTO sandboxes (id, preview_id, organization_id, name, source_type, source_image, snapshot_id, source_registry_id, cpu_count, memory_mb, disk_gb, state, desired_state, created_by_user_id, auto_stop_minutes, auto_archive_minutes, auto_delete_minutes, ephemeral, code_trust, has_ever_received_environment_secrets, repository, repository_branch, setup_command, workspace_path, compute_node_id, startup_command, readiness_command, initialization_command, prebuild_id, repository_revision, preview_enabled, preview_port)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning', 'running', $12, $13, $14, $15, $16, 'trusted', $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)`,
      [sandboxId, previewId, workspace.organization_id, name, sourceType, sourceType === "image" ? image : null, sourceType === "snapshot" ? snapshotId : null, sourceType === "image" ? registryId : null, cpu, memoryMb, diskGb, authSession.user.id, autoStopMinutes, autoArchiveMinutes, autoDeleteMinutes, ephemeral, parsedVariables.length > 0, development.repository, development.repository_branch, development.setup_command, development.workspace_path, computeNodeId, development.startup_command, development.readiness_command, development.initialization_command, input.prebuild_id || null, input.repository_revision || null, previewEnabled, parsePreviewPort(input.preview_port)],
    );
    if (personalMembershipId) {
      await client.query("UPDATE sandboxes SET personal_owner_user_id=$2 WHERE id=$1", [sandboxId, authSession.user.id]);
      await client.query("INSERT INTO environment_members (sandbox_id,membership_id) VALUES ($1,$2)", [sandboxId, personalMembershipId]);
    }
    await client.query("UPDATE sandboxes SET organization_secret_names = $2 WHERE id = $1", [sandboxId, organizationSecretNames]);
    await client.query("UPDATE sandboxes SET agent_configuration = $2 WHERE id = $1", [sandboxId, agentConfiguration]);
    for (const variable of parsedVariables) {
      const encrypted = encryptSecret(variable.value, secretContext.environment(workspace.organization_id, sandboxId, variable.name));
      await client.query(
        `INSERT INTO sandbox_environment_variables (sandbox_id, name, encrypted_value, iv)
         VALUES ($1, $2, $3, $4)`,
        [sandboxId, variable.name, encrypted.encryptedValue, encrypted.iv],
      );
    }
    for (const mount of parsedMounts.mounts) {
      await client.query(
        `INSERT INTO sandbox_volume_mounts (sandbox_id, volume_id, mount_path, subpath, read_only)
         VALUES ($1, $2, $3, $4, $5)`,
        [sandboxId, mount.volumeId, mount.mountPath, mount.subpath, mount.readOnly],
      );
    }
    await client.query(
      `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step)
       VALUES ($1, $2, 'create', 'queued', 'allocating')`,
      [jobId, sandboxId],
    );
    await client.query(
      `INSERT INTO sandbox_logs (sandbox_id, event_hash, recorded_at, severity, message)
       VALUES ($1, $2, now(), 'info', 'Environment queued for creation.') ON CONFLICT DO NOTHING`,
      [sandboxId, `${jobId}:queued`],
    );
    await queueWebhookEvent(client, workspace.organization_id, "environment.created", {
      environment: { id: sandboxId, name, state: "provisioning" },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && "constraint" in error && error.constraint === "sandboxes_one_personal_environment")
      return c.json({ error: "You already have a personal environment." }, 409);
    if (error instanceof Error && "code" in error && error.code === "23505")
      return c.json({ error: "An environment with that name already exists" }, 409);
    throw error;
  } finally {
    client.release();
  }
  return c.json({ id: sandboxId, status: "queued" }, 202);
}

export async function updateEnvironmentPreview(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input || typeof input.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  let port: number | null;
  try { port = parsePreviewPort(input.preview_port); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
  const result = await db.query(`UPDATE sandboxes SET preview_enabled=$1, preview_port=CASE WHEN $4 THEN $5::integer ELSE preview_port END, updated_at=now()
    WHERE id=$2 AND organization_id=$3 AND purpose='development' AND state<>'deleted' RETURNING preview_enabled, preview_port`,
    [input.enabled, c.req.param("id"), workspace.organization_id, Object.hasOwn(input, "preview_port"), port]);
  if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
  return c.json(result.rows[0]);
}

export async function updateEnvironmentSsh(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (typeof input?.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  const result = await db.query(`UPDATE sandboxes SET ssh_enabled=$1, updated_at=now()
    WHERE id=$2 AND organization_id=$3 AND purpose='development' AND state<>'deleted' RETURNING ssh_enabled`,
    [input.enabled, c.req.param("id"), workspace.organization_id]);
  if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
  return c.json(result.rows[0]);
}

export async function updateEnvironmentResources(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input || typeof input.cpu !== "number" || ![1, 2, 4, 8].includes(input.cpu))
    return c.json({ error: "Choose 1, 2, 4 or 8 vCPU" }, 400);
  if (typeof input.memory_mb !== "number" || ![1024, 2048, 4096, 8192, 16384].includes(input.memory_mb))
    return c.json({ error: "Choose 1, 2, 4, 8 or 16 GB of memory" }, 400);
  const id = c.req.param("id");
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ state: string; desired_state: string }>(
      "SELECT state, desired_state FROM sandboxes WHERE id=$1 AND organization_id=$2 AND purpose='development' AND state<>'deleted' FOR UPDATE",
      [id, workspace.organization_id],
    );
    if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
    if (result.rows[0]!.state !== "stopped" || result.rows[0]!.desired_state !== "stopped")
      return c.json({ error: "Stop the environment before changing its size" }, 409);
    const jobs = await client.query("SELECT 1 FROM compute_jobs WHERE sandbox_id=$1 AND status IN ('queued','leased')", [id]);
    const executions = await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id=$1 AND status IN ('queued','running')", [id]);
    if (jobs.rowCount || executions.rowCount)
      return c.json({ error: "Wait for the current environment operation to finish" }, 409);
    await client.query("UPDATE sandboxes SET cpu_count=$1, memory_mb=$2, updated_at=now() WHERE id=$3", [input.cpu, input.memory_mb, id]);
    await client.query("COMMIT");
    committed = true;
    return c.json({ cpu_count: input.cpu, memory_mb: input.memory_mb });
  } finally {
    if (!committed) await client.query("ROLLBACK");
    client.release();
  }
}

export async function updateEnvironmentLifecycle(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!input || !Object.hasOwn(input, "auto_stop_minutes"))
    return c.json({ error: "auto_stop_minutes is required" }, 400);
  const autoStopMinutes = optionalMinutes(input.auto_stop_minutes, null);
  if (autoStopMinutes === undefined)
    return c.json({ error: "Auto-stop must be between 1 and 525600 minutes" }, 400);
  const result = await db.query(
    `UPDATE sandboxes SET auto_stop_minutes=$1, updated_at=now()
     WHERE id=$2 AND organization_id=$3 AND purpose='development' AND state<>'deleted'
     RETURNING auto_stop_minutes`,
    [autoStopMinutes, c.req.param("id"), workspace.organization_id],
  );
  if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
  return c.json(result.rows[0]);
}

export async function upsertEnvironmentVariable(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const variable = parseEnvironmentVariable(await c.req.json().catch(() => null));
  if (!variable) return c.json({ error: "Invalid environment variable" }, 400);
  return changeEnvironmentVariable(c, workspace, variable.name, variable.value);
}

export async function deleteEnvironmentVariable(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const name = c.req.param("name") ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return c.json({ error: "Invalid environment variable name" }, 400);
  return changeEnvironmentVariable(c, workspace, name);
}

async function changeEnvironmentVariable(c: Context<AppEnv>, workspace: Workspace, name: string, value?: string) {
  const id = c.req.param("id")!;
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<{ code_trust: string }>(
      "SELECT code_trust FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted' FOR UPDATE",
      [id, workspace.organization_id],
    );
    if (!result.rowCount) return c.json({ error: "Environment not found" }, 404);
    if (result.rows[0]?.code_trust !== "trusted")
      return c.json({ error: "Untrusted code cannot receive environment variables" }, 403);
    const jobs = await client.query(
      "SELECT 1 FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued', 'leased')",
      [id],
    );
    if (jobs.rowCount) return c.json({ error: "Wait for the current environment operation to finish" }, 409);
    if (value === undefined) {
      await client.query("DELETE FROM sandbox_environment_variables WHERE sandbox_id = $1 AND name = $2", [id, name]);
    } else {
      const variables = await client.query<{ name: string }>(
        "SELECT name FROM sandbox_environment_variables WHERE sandbox_id = $1", [id],
      );
      if (variables.rows.length >= 25 && !variables.rows.some((item) => item.name === name))
        return c.json({ error: "Use at most 25 environment variables" }, 400);
      const encrypted = encryptSecret(value, secretContext.environment(workspace.organization_id, id, name));
      await client.query(
        `INSERT INTO sandbox_environment_variables (sandbox_id, name, encrypted_value, iv)
         VALUES ($1, $2, $3, $4) ON CONFLICT (sandbox_id, name)
         DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, iv = EXCLUDED.iv`,
        [id, name, encrypted.encryptedValue, encrypted.iv],
      );
      await client.query("UPDATE sandboxes SET has_ever_received_environment_secrets = true WHERE id = $1", [id]);
    }
    await client.query("UPDATE sandboxes SET updated_at = now(), organization_secret_names = array_remove(organization_secret_names, $2) WHERE id = $1", [id, name]);
    await client.query("COMMIT");
    committed = true;
    return c.json({ success: true });
  } finally {
    try { if (!committed) await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

function optionalMinutes(value: unknown, fallback: number | null): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null || value === "" || value === false) return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 525600 ? minutes : undefined;
}

export async function environmentAction(c: Context<AppEnv>, authSession: AuthSession) {
  const workspace = await workspaceFor(authSession.user, authSession.session.activeOrganizationId);
  const sandboxId = c.req.param("id");
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  const action = String(input?.action ?? "");
  if (!new Set(["start", "stop", "delete"]).has(action))
    return c.json({ error: "Unknown action" }, 400);
  let operation = action;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (workspace.role !== "admin") {
      const owner = await client.query(`SELECT 1 FROM sandboxes WHERE id=$1 AND organization_id=$2
        AND personal_owner_user_id=$3 AND can_access_environment(id,$3) FOR UPDATE`, [sandboxId, workspace.organization_id, authSession.user.id]);
      if (!owner.rowCount) { await client.query("ROLLBACK"); return c.json({ error: "Only admins can manage an assigned environment." }, 403); }
    }
    const sandbox = await client.query<{ runtime_id: string | null; state: string; provisioning_step: string; development_pending: boolean }>(
      `SELECT runtime_id, state, provisioning_step,
       ((repository IS NOT NULL OR setup_command IS NOT NULL OR startup_command IS NOT NULL OR readiness_command IS NOT NULL OR initialization_command IS NOT NULL) AND NOT EXISTS
         (SELECT 1 FROM compute_jobs WHERE sandbox_id = sandboxes.id AND operation = 'create' AND status = 'succeeded')) AS development_pending
       FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development' FOR UPDATE`,
      [sandboxId, workspace.organization_id],
    );
    if (!sandbox.rows[0]) {
      await client.query("ROLLBACK");
      return c.json({ error: "Environment not found" }, 404);
    }
    if (action !== "delete" && (await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id = $1 AND status IN ('queued','running')", [sandboxId])).rowCount) {
      await client.query("ROLLBACK"); return c.json({ error: "Cancel and wait for the active execution first" }, 409);
    }
    if (action === "delete") await client.query("UPDATE sandbox_executions SET cancel_requested = true WHERE sandbox_id = $1 AND status IN ('queued','running')", [sandboxId]);
    const activeJob = await client.query<{ id: string; operation: string; status: string }>(
      "SELECT id, operation, status FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued', 'leased')",
      [sandboxId],
    );
    if (activeJob.rows[0]) {
      if (action === "start" && activeJob.rows[0].operation === "create") {
        await client.query("COMMIT");
        return c.json({ status: "queued", operation: "create" }, 202);
      }
      if (action === "delete" && !sandbox.rows[0].runtime_id && activeJob.rows[0].status === "queued") {
        // Agent claims lock the job before the sandbox. Never wait in reverse order.
        let cancellable;
        try { cancellable = await client.query("SELECT id FROM compute_jobs WHERE id=$1 AND status='queued' FOR UPDATE NOWAIT", [activeJob.rows[0].id]); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "55P03") throw error;
          await client.query("ROLLBACK");
          return c.json({ error: "Operation is being claimed; wait for provisioning before deleting" }, 409);
        }
        if (!cancellable.rowCount) {
          await client.query("ROLLBACK");
          return c.json({ error: "Operation already in progress" }, 409);
        }
        await client.query(
          "UPDATE compute_jobs SET status = 'failed', error_message = 'Cancelled before provisioning', updated_at = now() WHERE id = $1",
          [activeJob.rows[0].id],
        );
        await client.query(
          "UPDATE sandboxes SET state = 'deleted', desired_state = 'deleted', updated_at = now() WHERE id = $1",
          [sandboxId],
        );
        await queueWebhookEvent(client, workspace.organization_id, "environment.deleted", {
          environment: { id: sandboxId, state: "deleted" },
        });
        await client.query("COMMIT");
        return c.json({ status: "deleted", operation: "delete" });
      }
      await client.query("ROLLBACK");
      return c.json({ error: `Operation already in progress: ${activeJob.rows[0].operation}` }, 409);
    }
    operation = action === "start" && (!sandbox.rows[0].runtime_id || sandbox.rows[0].development_pending) ? "create" : action;
    const desiredState = action === "delete" ? "deleted" : action === "stop" ? "stopped" : "running";
    await client.query(
      `UPDATE sandboxes SET desired_state = $1, state = 'provisioning',
       manual_stop = ($1 = 'stopped'),
       provisioning_step = 'allocating', error_message = NULL,
       last_activity_at = CASE WHEN $1 = 'running' THEN now() ELSE last_activity_at END,
       updated_at = now() WHERE id = $2`,
      [desiredState, sandboxId],
    );
    await client.query(
      "INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step) VALUES ($1, $2, $3, 'queued', 'allocating')",
      [`job_${crypto.randomUUID()}`, sandboxId, operation],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return c.json({ status: "queued", operation }, 202);
}
