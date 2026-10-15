import { resolveAgentSetup } from "./agents.js";
import type { AgentConfiguration } from "./agent-config.js";
import { resolveOrganizationSecrets } from "./org-secrets.js";
import { resolveSnapshotConfiguration } from "./snapshot-configuration.js";
import { listSystemSnapshots, resolveSystemSnapshot } from "./system-snapshots.js";
import { resolvePrebuild } from "./prebuilds.js";
import { parseDevelopmentConfig, parsePreviewPort, parseOrganizationSecretNames } from "./development-config.js";
import { db } from "./db.js";
import { queueReasonSql } from "./resource-reservations.js";
import { selectHost } from "./host-placement.js";
import type { PoolClient } from "pg";
import { config } from "./config.js";
import { encryptSecret, secretContext } from "./secrets.js";
import { queueWebhookEvent } from "./webhooks.js";

export type EnvironmentActor = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  actorUserId: string;
  automationIdPrefix: string | null;
  accessUserId?: string | undefined;
};

export class EnvironmentServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const environmentColumns = `(SELECT json_build_object('expires_at',p.expires_at,'lease_expires_at',p.lease_expires_at,'status',p.status) FROM agent_session_protections p WHERE p.sandbox_id=sandboxes.id AND p.runtime_id=sandboxes.runtime_id AND p.status IN ('launching','running') AND p.expires_at>now() AND p.lease_expires_at>now()) AS agent_protection, agent_configuration, application_status, application_status_at, organization_secret_names, preview_port, preview_enabled, prebuild_id, repository, repository_branch, workspace_path, initialization_command, startup_command, readiness_command, id, name, state, desired_state, source_type, source_image, snapshot_id,
  ssh_enabled, source_registry_id, cpu_count, memory_mb, disk_gb, runtime_id, compute_node_id,
  provisioning_step, error_message, created_at, updated_at, last_activity_at, auto_stop_minutes,
  auto_archive_minutes, auto_delete_minutes, ephemeral, code_trust, automation_id, source_revision,
  (SELECT operation FROM compute_jobs WHERE sandbox_id = sandboxes.id AND status IN ('queued', 'leased') LIMIT 1) AS active_operation,
  ${queueReasonSql} AS queue_reason`;

export async function listEnvironmentsForActor(actor: EnvironmentActor) {
  const result = await db.query(
    `SELECT ${environmentColumns}
     FROM sandboxes WHERE organization_id = $1 AND purpose = 'development' AND state <> 'deleted'
       AND (preview_template_id IS NULL OR preview_claim_key IS NOT NULL)
       AND ($2::text IS NULL OR automation_id LIKE $2 || '%')
       AND ($3::text IS NULL OR can_access_environment(id,$3))
     ORDER BY created_at DESC`,
    [actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null],
  );
  return result.rows;
}

export async function getEnvironmentForActor(actor: EnvironmentActor, environmentId: string) {
  const result = await db.query(
    `SELECT ${environmentColumns}
     FROM sandboxes WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted'
       AND ($3::text IS NULL OR automation_id LIKE $3 || '%')
       AND ($4::text IS NULL OR can_access_environment(id,$4))`,
    [environmentId, actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null],
  );
  const environment = result.rows[0];
  if (!environment) throw new EnvironmentServiceError(404, "Environment not found");
  const variables = await db.query<{ name: string }>(
    "SELECT name FROM sandbox_environment_variables WHERE sandbox_id = $1 ORDER BY name",
    [environmentId],
  );
  return {
    ...environment,
    environment_variable_names: variables.rows.map((row) => row.name),
    ssh_username: `${actor.organizationSlug}.${String(environment.name)}`,
  };
}

function optionalMinutes(value: unknown, fallback: number | null): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null || value === "" || value === false) return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 525600 ? minutes : undefined;
}

type ParsedEnvironmentInput = {
  name: string;
  sourceType: "image" | "snapshot";
  image: string;
  snapshotId: string;
  registryId: string | null;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  autoStopMinutes: number | null;
  autoArchiveMinutes: number | null;
  autoDeleteMinutes: number | null;
  ephemeral: boolean;
  previewEnabled: boolean;
  codeTrust: "trusted" | "untrusted";
  automationId: string | null;
  sourceRevision: string | null;
  variables: Array<{ name: string; value: string }>;
};

function parseEnvironmentInput(input: Record<string, unknown>): ParsedEnvironmentInput {
  const requestedName = String(input.name ?? "").trim().toLowerCase();
  const name = requestedName || `env-${crypto.randomUUID().slice(0, 8)}`;
  const sourceType = input.source_type === "snapshot" ? "snapshot" : "image";
  const image = String(input.image ?? "").trim();
  const snapshotId = String(input.snapshot_id ?? "").trim();
  const registryId = String(input.registry_id ?? "").trim() || null;
  const cpu = Number(input.cpu ?? 1);
  const memoryMb = Number(input.memory_mb ?? 2048);
  const diskGb = Number(input.disk_gb ?? 40);
  const codeTrust = input.code_trust === "trusted" ? "trusted" : "untrusted";
  const autoStopMinutes = optionalMinutes(input.auto_stop_minutes, 15);
  const autoArchiveMinutes = optionalMinutes(input.auto_archive_minutes, 10080);
  const autoDeleteMinutes = optionalMinutes(input.auto_delete_minutes, codeTrust === "untrusted" ? 360 : null);
  const ephemeral = input.ephemeral === true;
  const previewEnabled = input.preview_enabled !== false;
  const automationId = String(input.automation_id ?? "").trim() || null;
  const sourceRevision = String(input.source_revision ?? "").trim().toLowerCase() || null;
  const rawVariables = Array.isArray(input.environment_variables) ? input.environment_variables : [];
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    throw new EnvironmentServiceError(400, "Invalid environment name");
  if (sourceType === "image" && (!image || /\s|\.\./.test(image) || image.length > 240))
    throw new EnvironmentServiceError(400, "Invalid OCI image reference");
  if (sourceType === "image" && !/@sha256:[a-f0-9]{64}$/.test(image))
    throw new EnvironmentServiceError(400, "Automated environments require an OCI image pinned by sha256 digest");
  if (sourceType === "snapshot" && !snapshotId)
    throw new EnvironmentServiceError(400, "Select a snapshot");
  if (![1, 2, 4, 8].includes(cpu)) throw new EnvironmentServiceError(400, "Invalid CPU count");
  if (![1024, 2048, 4096, 8192, 16384].includes(memoryMb))
    throw new EnvironmentServiceError(400, "Invalid memory size");
  if (![20, 40, 50, 80, 100].includes(diskGb))
    throw new EnvironmentServiceError(400, "Invalid disk size");
  if (autoStopMinutes === undefined || autoArchiveMinutes === undefined || autoDeleteMinutes === undefined)
    throw new EnvironmentServiceError(400, "Lifecycle values must be whole minutes or disabled");
  if (rawVariables.length > 25)
    throw new EnvironmentServiceError(400, "Use at most 25 environment variables");
  if ((automationId === null) !== (sourceRevision === null))
    throw new EnvironmentServiceError(400, "automation_id and source_revision must be provided together");
  if (automationId && !/^github:[0-9]+:pr:[1-9][0-9]*$/.test(automationId))
    throw new EnvironmentServiceError(400, "automation_id must use github:<repository-id>:pr:<number>");
  if (sourceRevision && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision))
    throw new EnvironmentServiceError(400, "source_revision must be an exact 40 or 64 character commit hash");
  if (codeTrust === "untrusted" && rawVariables.length)
    throw new EnvironmentServiceError(400, "Untrusted code cannot receive environment variables");
  const variables: Array<{ name: string; value: string }> = [];
  const names = new Set<string>();
  for (const item of rawVariables) {
    if (!item || typeof item !== "object")
      throw new EnvironmentServiceError(400, "Invalid environment variable");
    const variable = item as Record<string, unknown>;
    const variableName = String(variable.name ?? "").trim();
    const value = String(variable.value ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName) || value.length > 32768 || names.has(variableName))
      throw new EnvironmentServiceError(400, `Invalid or duplicate environment variable: ${variableName || "unnamed"}`);
    names.add(variableName);
    variables.push({ name: variableName, value });
  }
  return {
    name, sourceType, image, snapshotId, registryId, cpu, memoryMb, diskGb,
    autoStopMinutes, autoArchiveMinutes, autoDeleteMinutes, ephemeral, previewEnabled, codeTrust,
    automationId, sourceRevision, variables,
  };
}

export async function createEnvironmentForActor(
  actor: EnvironmentActor,
  rawInput: Record<string, unknown>,
  transactionClient?: PoolClient,
) {
  if (actor.automationIdPrefix && rawInput.prebuild_id) throw new EnvironmentServiceError(403, "Repository-scoped keys cannot use project prebuilds");
  rawInput = await resolvePrebuild(actor.organizationId, rawInput, transactionClient ?? db);
  try { rawInput = await resolveSystemSnapshot(rawInput, transactionClient ?? db); }
  catch (error) { throw new EnvironmentServiceError(400, error instanceof Error ? error.message : "Invalid system snapshot"); }
  let development: ReturnType<typeof parseDevelopmentConfig>;
  let organizationSecretNames: string[];
  try {
    rawInput = await resolveSnapshotConfiguration(actor.organizationId, rawInput, transactionClient ?? db);
    development = parseDevelopmentConfig(rawInput);
    organizationSecretNames = parseOrganizationSecretNames(rawInput.organization_secret_names);
    parsePreviewPort(rawInput.preview_port);
  }
  catch (error) { throw new EnvironmentServiceError(400, error instanceof Error ? error.message : "Invalid project commands"); }
  if (development.repository && !rawInput.prebuild_id) throw new EnvironmentServiceError(400, "Use a ready prebuild for repository-based API environments");
  const input = parseEnvironmentInput(rawInput);
  if (organizationSecretNames.length && (input.codeTrust !== "trusted" || actor.automationIdPrefix)) throw new EnvironmentServiceError(403, "Organization secrets require a trusted environment and an unrestricted organization actor");
  if (input.codeTrust !== "trusted" && (rawInput.prebuild_id || development.setup_command || development.startup_command || development.readiness_command || development.initialization_command)) throw new EnvironmentServiceError(403, "Project setup commands require an explicitly trusted environment");
  if (input.codeTrust === "untrusted" && !config.allowUntrustedCode)
    throw new EnvironmentServiceError(503, "Untrusted code execution is disabled until compute isolation has been verified");
  if (actor.automationIdPrefix && !input.automationId?.startsWith(actor.automationIdPrefix))
    throw new EnvironmentServiceError(403, "This API key can only create environments for its GitHub repository");
  if (actor.automationIdPrefix && (input.codeTrust !== "untrusted" || input.sourceType !== "image" || input.variables.length))
    throw new EnvironmentServiceError(403, "GitHub automation keys may only run untrusted image environments without environment variables");
  const sandboxId = `dev_${crypto.randomUUID()}`;
  const jobId = `job_${crypto.randomUUID()}`;
  const client = transactionClient ?? await db.connect();
  const managesTransaction = !transactionClient;
  try {
    if (managesTransaction) await client.query("BEGIN");
    let agentConfiguration: AgentConfiguration | null = null;
    try {
      const agent = await resolveAgentSetup(actor.organizationId, rawInput.agent_id, input.codeTrust === "trusted" && !actor.automationIdPrefix, organizationSecretNames, client, rawInput.agent_auth_method, actor.accessUserId);
      agentConfiguration = agent.configuration;
      input.variables.push(...await resolveOrganizationSecrets(actor.organizationId, agent.secretNames, input.variables, client));
    }
    catch (error) { throw new EnvironmentServiceError(400, error instanceof Error ? error.message : "Could not resolve organization secrets"); }
    if (input.sourceType === "snapshot") {
      const snapshot = await client.query(
        "SELECT 1 FROM workspace_snapshots WHERE id = $1 AND organization_id = $2 AND status = 'ready'",
        [input.snapshotId, actor.organizationId],
      );
      if (!snapshot.rowCount) throw new EnvironmentServiceError(400, "Snapshot is not ready or does not exist");
    }
    if (input.registryId) {
      const registry = await client.query(
        "SELECT 1 FROM workspace_registries WHERE id = $1 AND organization_id = $2",
        [input.registryId, actor.organizationId],
      );
      if (!registry.rowCount) throw new EnvironmentServiceError(400, "Registry does not exist");
    }
    let computeNodeId: string | null;
    try { computeNodeId = await selectHost(client, actor.organizationId, rawInput.compute_node_id, input.sourceType === "snapshot" ? input.snapshotId : null); }
    catch (error) { throw new EnvironmentServiceError(400, error instanceof Error ? error.message : "Could not select a compute host"); }
    await client.query(
      `INSERT INTO sandboxes
       (id, preview_id, organization_id, name, source_type, source_image, snapshot_id,
        source_registry_id, cpu_count, memory_mb, disk_gb, state, desired_state,
        created_by_user_id, auto_stop_minutes, auto_archive_minutes, auto_delete_minutes, ephemeral,
        code_trust, has_ever_received_environment_secrets, automation_id, source_revision, compute_node_id, repository, repository_branch, setup_command, startup_command, readiness_command, initialization_command, workspace_path, prebuild_id, repository_revision, preview_enabled, preview_port)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning',
               'running', $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)`,
      [sandboxId, crypto.randomUUID(), actor.organizationId, input.name, input.sourceType,
       input.sourceType === "image" ? input.image : null,
       input.sourceType === "snapshot" ? input.snapshotId : null,
       input.sourceType === "image" ? input.registryId : null,
       input.cpu, input.memoryMb, input.diskGb, actor.actorUserId, input.autoStopMinutes,
       input.autoArchiveMinutes, input.autoDeleteMinutes, input.ephemeral, input.codeTrust,
       input.variables.length > 0, input.automationId, input.sourceRevision, computeNodeId, development.repository, development.repository_branch, development.setup_command, development.startup_command, development.readiness_command, development.initialization_command, development.workspace_path, rawInput.prebuild_id || null, rawInput.repository_revision || null, input.previewEnabled, parsePreviewPort(rawInput.preview_port)],
    );
    await client.query("UPDATE sandboxes SET organization_secret_names = $2 WHERE id = $1", [sandboxId, organizationSecretNames]);
    await client.query("UPDATE sandboxes SET agent_configuration = $2 WHERE id = $1", [sandboxId, agentConfiguration]);
    for (const variable of input.variables) {
      const encrypted = encryptSecret(variable.value, secretContext.environment(actor.organizationId, sandboxId, variable.name));
      await client.query(
        `INSERT INTO sandbox_environment_variables (sandbox_id, name, encrypted_value, iv)
         VALUES ($1, $2, $3, $4)`,
        [sandboxId, variable.name, encrypted.encryptedValue, encrypted.iv],
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
    await queueWebhookEvent(client, actor.organizationId, "environment.created", {
      environment: { id: sandboxId, name: input.name, state: "provisioning" },
    });
    if (managesTransaction) await client.query("COMMIT");
    return { environment_id: sandboxId, operation_id: jobId, status: "queued" as const };
  } catch (error) {
    if (managesTransaction) await client.query("ROLLBACK");
    if (error instanceof EnvironmentServiceError) throw error;
    if (error instanceof Error && "code" in error && error.code === "23505")
      throw new EnvironmentServiceError(409, "An environment with that name already exists");
    throw error;
  } finally {
    if (managesTransaction) client.release();
  }
}

export async function changeEnvironmentStateForActor(
  actor: EnvironmentActor,
  environmentId: string,
  action: "start" | "stop" | "delete",
  transactionClient?: PoolClient,
) {
  const client = transactionClient ?? await db.connect();
  const managesTransaction = !transactionClient;
  try {
    if (managesTransaction) await client.query("BEGIN");
    const sandbox = await client.query<{ runtime_id: string | null; development_pending: boolean }>(
      `SELECT runtime_id, ((repository IS NOT NULL OR setup_command IS NOT NULL OR startup_command IS NOT NULL OR readiness_command IS NOT NULL OR initialization_command IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM compute_jobs WHERE sandbox_id = sandboxes.id AND operation = 'create' AND status = 'succeeded')) AS development_pending FROM sandboxes
       WHERE id = $1 AND organization_id = $2 AND purpose = 'development' AND state <> 'deleted'
         AND ($3::text IS NULL OR automation_id LIKE $3 || '%')
       AND ($4::text IS NULL OR can_access_environment(id,$4)) FOR UPDATE`,
      [environmentId, actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null],
    );
    if (!sandbox.rows[0]) throw new EnvironmentServiceError(404, "Environment not found");
    if (action !== "delete" && (await client.query("SELECT 1 FROM sandbox_executions WHERE sandbox_id = $1 AND status IN ('queued','running')", [environmentId])).rowCount)
      throw new EnvironmentServiceError(409,"Cancel and wait for the active execution first");
    const active = await client.query<{ id: string; operation: string; status: string }>(
      "SELECT id, operation, status FROM compute_jobs WHERE sandbox_id = $1 AND status IN ('queued', 'leased')",
      [environmentId],
    );
    if (active.rows[0]) {
      if (action === "start" && active.rows[0].operation === "create") {
        if (managesTransaction) await client.query("COMMIT");
        return { environment_id: environmentId, operation_id: active.rows[0].id, status: active.rows[0].status };
      }
      throw new EnvironmentServiceError(409, `Operation already in progress: ${active.rows[0].operation}`);
    }
    if (action === "delete") await client.query("UPDATE sandbox_executions SET cancel_requested = true WHERE sandbox_id = $1 AND status IN ('queued','running')", [environmentId]);
    const operation = action === "start" && (!sandbox.rows[0].runtime_id || sandbox.rows[0].development_pending) ? "create" : action;
    const desiredState = action === "delete" ? "deleted" : action === "stop" ? "stopped" : "running";
    const jobId = `job_${crypto.randomUUID()}`;
    await client.query(
      `UPDATE sandboxes SET desired_state = $1, state = 'provisioning',
       manual_stop = ($1 = 'stopped'),
       provisioning_step = 'allocating', error_message = NULL,
       last_activity_at = CASE WHEN $1 = 'running' THEN now() ELSE last_activity_at END,
       updated_at = now() WHERE id = $2`,
      [desiredState, environmentId],
    );
    await client.query(
      `INSERT INTO compute_jobs (id, sandbox_id, operation, status, provisioning_step)
       VALUES ($1, $2, $3, 'queued', 'allocating')`,
      [jobId, environmentId, operation],
    );
    if (managesTransaction) await client.query("COMMIT");
    return { environment_id: environmentId, operation_id: jobId, status: "queued" as const };
  } catch (error) {
    if (managesTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (managesTransaction) client.release();
  }
}

export async function listSnapshotsForActor(actor: EnvironmentActor) {
  if (actor.automationIdPrefix) return [];
  const result = await db.query(
    `SELECT id, name, version, status, kind, base_image, source_sandbox_id,
            snapshot_size_gb, error_message, created_at, last_used_at, launch_configuration
     FROM workspace_snapshots WHERE organization_id = $1
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND role IN ('admin','owner')) OR can_access_environment(source_sandbox_id,$2)) ORDER BY created_at DESC`,
    [actor.organizationId, actor.accessUserId ?? null],
  );
  return [...await listSystemSnapshots(), ...result.rows];
}

export async function getOperationForActor(actor: EnvironmentActor, operationId: string) {
  const result = await db.query(
    `SELECT compute_jobs.id, compute_jobs.sandbox_id AS environment_id, compute_jobs.operation,
            compute_jobs.status, compute_jobs.provisioning_step, compute_jobs.attempts,
            compute_jobs.error_message, compute_jobs.created_at, compute_jobs.updated_at
     FROM compute_jobs JOIN sandboxes ON sandboxes.id = compute_jobs.sandbox_id
     WHERE compute_jobs.id = $1 AND sandboxes.organization_id = $2
       AND ($3::text IS NULL OR sandboxes.automation_id LIKE $3 || '%')
       AND ($4::text IS NULL OR can_access_environment(sandboxes.id,$4))`,
    [operationId, actor.organizationId, actor.automationIdPrefix, actor.accessUserId ?? null],
  );
  const operation = result.rows[0];
  if (!operation) throw new EnvironmentServiceError(404, "Operation not found");
  return operation;
}
