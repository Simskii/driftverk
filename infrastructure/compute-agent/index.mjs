import { processAgentSessions } from './agent-sessions.mjs';
import { processExecutions } from "./executions.mjs";
import { DockerSandboxRuntime, runCommand } from "./docker-runtime.mjs";
import { cpus, totalmem } from "node:os";
import { activeSnapshotTempDirectories, createSnapshotStorage, snapshotStorageKey } from "./snapshot-storage.mjs";
import { VolumeStorage } from "./volume-storage.mjs";
import { startDataTunnel } from "./data-tunnel.mjs";
import { parseImageCleanupConfig, runImageCleanup } from "./image-cleanup.mjs";
import { checkHealth, canClaimJobs, allowedOperations } from "./health.mjs";
import Docker from "dockerode";
import { writeFile } from 'node:fs/promises';

// Liveness is independent of dependency health: restarting the agent cannot fix Sysbox.
setInterval(() => { void writeFile('/tmp/driftverk-agent-alive', String(Date.now())).catch(() => {}); }, 5000).unref();

const healthDocker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 5000 });
let health = null;
let tunnelConnected = false;

const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.replace(/\/$/, "");
const token = process.env.COMPUTE_AGENT_TOKEN;
const nodeId = process.env.COMPUTE_NODE_ID;
const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 500);
const telemetryInterval = Number(process.env.TELEMETRY_INTERVAL_MS ?? 15000);
const computeAgentVersion = process.env.COMPUTE_AGENT_VERSION ?? "development";
const storageDriver = process.env.SNAPSHOT_STORAGE_DRIVER ?? "local";
const imageCleanup = parseImageCleanupConfig(process.env);

if (!Number.isFinite(pollInterval) || pollInterval < 250 || !Number.isFinite(telemetryInterval) || telemetryInterval < 1000)
  throw new Error("POLL_INTERVAL_MS must be at least 250 and TELEMETRY_INTERVAL_MS at least 1000");

if (!controlPlaneUrl || !token || !nodeId) {
  console.error(
    "CONTROL_PLANE_URL, COMPUTE_AGENT_TOKEN and COMPUTE_NODE_ID are required",
  );
  process.exit(1);
}

const dataGatewayUrl = process.env.DATA_GATEWAY_URL?.trim() || `${controlPlaneUrl.replace(/^http/, "ws")}/api/tunnel/agent`;

const volumeStorage = new VolumeStorage(process.env, { runner: runCommand });
const runtime = new DockerSandboxRuntime({
  runtime: process.env.DOCKER_RUNTIME ?? "",
  network: process.env.SANDBOX_NETWORK ?? "bridge",
  snapshotStorage: createSnapshotStorage(process.env),
  volumeStorage,
});

startDataTunnel({
  onConnectionChange: connected => { tunnelConnected = connected; },
  url: dataGatewayUrl,
  token,
  nodeId,
  controlPlaneUrl,
  sandboxNetwork: process.env.SANDBOX_NETWORK ?? "bridge",
});

async function api(path, body) {
  const response = await fetch(`${controlPlaneUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error ?? `Control plane returned ${response.status}`);
  return result;
}

async function report(jobId, event, fields = {}) {
  return api(`/api/compute/jobs/${encodeURIComponent(jobId)}/events`, {
    node_id: nodeId,
    event,
    ...fields,
  });
}

async function execute(claim) {
  const { job, sandbox } = claim;
  const progress = (step, runtimeId) => report(job.id, "progress", { step, ...(runtimeId ? { runtime_id: runtimeId } : {}) });
  const heartbeat = setInterval(() => {
    report(job.id, "heartbeat").catch((error) => {
      console.error(
        JSON.stringify({
          event: "job_heartbeat_failed",
          job_id: job.id,
          message: error instanceof Error ? error.message : "Unknown heartbeat error",
        }),
      );
    });
  }, 20_000);
  try {
    let runtimeId;
    if (job.operation === "create") {
      runtimeId = await runtime.create(sandbox, progress);
      if (sandbox.purpose === "prebuild") {
        await progress("capturing-prebuild", runtimeId);
        const captured = await runtime.snapshot({ ...sandbox, runtime_id: runtimeId }, job.snapshot);
        await runtime.delete({ ...sandbox, runtime_id: runtimeId });
        await report(job.id, "succeeded", { runtime_id: runtimeId, artifact_ref: captured.artifactRef, snapshot_size_gb: captured.snapshotSizeGb });
        return;
      }
    }
    else if (job.operation === "start")
      runtimeId = await runtime.start(sandbox, progress);
    else if (job.operation === "stop") {
      const decision = await report(job.id, "stopping");
      if (decision.stop === false) return;
      if (decision.stop !== true) throw new Error("Control plane did not authorize shutdown");
      runtimeId = await runtime.stop(sandbox);
    }
    else if (job.operation === "delete") {
      const decision = await report(job.id, "deleting");
      if (decision.delete === false) return;
      if (decision.delete !== true) throw new Error("Control plane did not authorize deletion");
      runtimeId = await runtime.delete(sandbox);
    }
    else if (job.operation === "snapshot") {
      const captured = await runtime.snapshot(sandbox, job.snapshot);
      await report(job.id, "succeeded", {
        runtime_id: sandbox.runtime_id,
        artifact_ref: captured.artifactRef,
        snapshot_size_gb: captured.snapshotSizeGb,
      });
      console.log(JSON.stringify({ event: "job_succeeded", job_id: job.id }));
      return;
    }
    else throw new Error(`Unsupported operation: ${job.operation}`);
    await report(job.id, "succeeded", { runtime_id: runtimeId });
    console.log(JSON.stringify({ event: "job_succeeded", job_id: job.id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown compute error";
    if (sandbox.purpose === "prebuild") {
      const runtimeId = await runtime.inspect(sandbox.runtime_id || `driftverk-${sandbox.id}`).catch(() => null);
      if (runtimeId) await runtime.delete({ ...sandbox, runtime_id: runtimeId }).catch(() => {});
    }
    await report(job.id, "failed", { error: message }).catch((reportError) => {
      console.error(
        JSON.stringify({
          event: "job_failure_report_failed",
          job_id: job.id,
          message:
            reportError instanceof Error ? reportError.message : "Unknown report error",
        }),
      );
    });
    console.error(
      JSON.stringify({ event: "job_failed", job_id: job.id, message }),
    );
  } finally {
    clearInterval(heartbeat);
  }
}

// Reserve one serial worker for resume. A slow image pull or snapshot cannot
// occupy it; disjoint operations also prevent self-reclaiming an active lease.
async function jobLoop(operations) {
  for (;;) {
    try {
      const availableOperations = allowedOperations(health, operations);
      if (!availableOperations.length) { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
      const claim = await api("/api/compute/jobs/claim", {
        health,
        accepting_jobs: true,
        node_id: nodeId,
        version: computeAgentVersion,
        storage_driver: storageDriver,
        snapshot_storage_key: snapshotStorageKey(process.env),
        capacity: { cpu_count: cpus().length, memory_mb: Math.floor(totalmem() / 1024 / 1024) },
        operations: availableOperations,
        capabilities: ["development-setup-v1", "project-readiness-v1", "prebuilds-v1", "runtime-recovery-v1"],
      });
      if (claim && !operations.includes(claim.job.operation)) throw new Error("Upgrade the control plane before running the resume worker");
      if (claim) await execute(claim);
      else await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      console.error(JSON.stringify({ event: "compute_agent_poll_failed", message: error instanceof Error ? error.message : String(error) }));
      await new Promise((resolve) => setTimeout(resolve, Math.max(pollInterval, 5000)));
    }
  }
}

async function maintenanceLoop() {
  let nextVolumeReconcileAt = 0;
  let nextImageCleanupAt = 0;
  for (;;) {
    try {
      if (Date.now() >= nextVolumeReconcileAt) {
        const attached = await api("/api/compute/volumes", { node_id: nodeId });
        await volumeStorage.prepare(attached.volumes);
        const volume_sizes = await volumeStorage.sizes(attached.metered_volumes ?? attached.volumes);
        if (volume_sizes.length) await api("/api/compute/telemetry", { node_id: nodeId, volume_sizes });
        nextVolumeReconcileAt = Date.now() + 60_000;
      }
      const samples = await runtime.telemetry();
      if (samples.length) await api("/api/compute/telemetry", { node_id: nodeId, samples });
      if (Date.now() >= nextImageCleanupAt) {
        const protection = await api("/api/compute/images/protected", { node_id: nodeId });
        const result = await runImageCleanup({
          runner: runCommand,
          protectedSnapshotIds: new Set(protection.protected_snapshot_ids),
          storageDriver,
          tempDirectory: process.env.SNAPSHOT_TEMP_DIR ?? "/snapshot-tmp",
          minAgeHours: imageCleanup.minAgeHours,
          tempRetentionHours: imageCleanup.tempRetentionHours,
          maxImages: imageCleanup.maxImages,
          activeTempDirectories: activeSnapshotTempDirectories,
        });
        console.log(JSON.stringify({
          event: "compute_image_cleanup_finished",
          node_id: nodeId,
          managed_images_planned: result.managed.planned,
          managed_images_removed: result.managed.removed.length,
          managed_images_in_use: result.managed.skippedInUse.length,
          managed_image_errors: result.managed.errors.length,
          dangling_prune: result.pruned.output,
          temp_directories_removed: result.temp.removed.length,
          temp_directory_errors: result.temp.errors.length,
        }));
        nextImageCleanupAt = Date.now() + imageCleanup.intervalMs;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "compute_agent_maintenance_failed", message: error instanceof Error ? error.message : String(error) }));
      nextImageCleanupAt = Date.now() + Math.min(imageCleanup.intervalMs, 60_000);
    }
    await new Promise((resolve) => setTimeout(resolve, telemetryInterval));
  }
}

console.log(JSON.stringify({ event: "compute_agent_started", node_id: nodeId }));
async function healthLoop() {
  for (;;) {
    try {
      health = await checkHealth({ docker: () => healthDocker.ping(), sysbox: process.env.DOCKER_RUNTIME === 'sysbox-runc', watchdogFile: process.env.HOST_HEALTH_FILE, tunnelConnected });
      console.log(JSON.stringify({ event: 'compute_health', ...health }));
      await api('/api/compute/health', { node_id: nodeId, version: computeAgentVersion, health });
    } catch { health = null; }
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
}
await Promise.all([
  healthLoop(),
  jobLoop(["start"]),
  // Shutdown must remain available while another environment builds or snapshots.
  jobLoop(["stop", "delete"]),
  jobLoop(["create", "snapshot"]),
  maintenanceLoop(),
  executionLoop(),
  agentSessionLoop(),
]);

async function executionLoop() {
  for (;;) {
    try { if (canClaimJobs(health)) await processExecutions(api); }
    catch { console.error(JSON.stringify({ event: "execution_poll_failed" })); }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

async function agentSessionLoop() {
  for (;;) {
    try { await processAgentSessions(api); }
    catch { console.error(JSON.stringify({event: "agent_session_poll_failed"})); }
    await new Promise(resolve=>setTimeout(resolve,15000));
  }
}
