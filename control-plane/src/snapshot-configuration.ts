import type { PoolClient } from "pg";
import { db } from "./db.js";

export type SnapshotLaunchConfiguration = {
  cpu: number;
  memory_mb: number;
  workspace_path: string | null;
  startup_command: string | null;
  readiness_command: string | null;
  preview_enabled: boolean;
  preview_port: number | null;
};

// Keep launch defaults separate from files. Never copy variables, mounts, clone,
// install, or initialization commands into a restored environment's configuration.
export function snapshotLaunchConfiguration(environment: {
  cpu_count: number; memory_mb: number; workspace_path: string | null;
  startup_command: string | null; readiness_command: string | null;
  preview_enabled: boolean; preview_port: number | null;
}): SnapshotLaunchConfiguration {
  return {
    cpu: environment.cpu_count, memory_mb: environment.memory_mb,
    workspace_path: environment.workspace_path, startup_command: environment.startup_command,
    readiness_command: environment.readiness_command, preview_enabled: environment.preview_enabled,
    preview_port: environment.preview_port,
  };
}

export async function resolveSnapshotConfiguration(organizationId: string, input: Record<string, unknown>, client: Pick<PoolClient, "query"> = db): Promise<Record<string, unknown>> {
  // Repository creation and prebuilds have their own setup contract.
  if (input.source_type !== "snapshot" || !input.snapshot_id || input.repository || input.prebuild_id) return input;
  const result = await client.query<{ launch_configuration: SnapshotLaunchConfiguration | null }>(
    "SELECT launch_configuration FROM workspace_snapshots WHERE id=$1 AND organization_id=$2 AND status='ready'",
    [input.snapshot_id, organizationId],
  );
  const saved = result.rows[0]?.launch_configuration;
  if (!saved) return input;
  return { ...saved, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
}
