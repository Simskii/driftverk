import type { PoolClient } from "pg";

// Called in the environment creation transaction. Shared host locks serialize
// registration removal against placement without serializing environment creation.
export async function selectHost(client: PoolClient, organizationId: string, requested: unknown, snapshotId: string | null) {
  if (requested !== undefined && requested !== null && (typeof requested !== "string" || !/^agent_[a-zA-Z0-9-]+$/.test(requested)))
    throw new Error("Select a valid compute host");
  const organization = await client.query("SELECT hosting_mode FROM organizations WHERE id = $1 FOR SHARE", [organizationId]);
  if (organization.rows[0]?.hosting_mode !== "hybrid") {
    if (requested) throw new Error("Host selection is only available for Hybrid organizations");
    return null;
  }
  const hosts = await client.query<{ id: string; snapshot_storage_key: string | null }>(
    "SELECT id, snapshot_storage_key FROM compute_agents WHERE organization_id = $1 AND revoked_at IS NULL ORDER BY id FOR SHARE",
    [organizationId],
  );
  if (!hosts.rowCount) throw new Error("Connect a compute host before creating an environment");
  if (requested && !hosts.rows.some(host => host.id === requested)) throw new Error("This compute host is not available in your organization");
  if (snapshotId) {
    const source = await client.query(`SELECT s.compute_node_id, snapshot.artifact_ref, snapshot.storage_key FROM workspace_snapshots snapshot
      JOIN sandboxes s ON s.id = snapshot.source_sandbox_id
      WHERE snapshot.id = $1 AND snapshot.organization_id = $2`, [snapshotId, organizationId]);
    const sourceHost = source.rows[0]?.compute_node_id;
    if (sourceHost && !source.rows[0]?.artifact_ref?.startsWith("s3://")) {
      if (requested && requested !== sourceHost) throw new Error("This snapshot is stored locally. Select its original host.");
      if (!hosts.rows.some(host => host.id === sourceHost)) throw new Error("The host storing this snapshot is no longer connected");
      return sourceHost as string;
    }
    if (source.rows[0]?.artifact_ref?.startsWith("s3://")) {
      const compatible = hosts.rows.filter(host => host.id === sourceHost || (source.rows[0].storage_key && host.snapshot_storage_key === source.rows[0].storage_key));
      if (!compatible.length || (requested && !compatible.some(host => host.id === requested)))
        throw new Error("This snapshot needs its original host or a host connected to the same S3 snapshot storage");
    }
  }
  // An unassigned environment is claimed atomically by the next eligible host.
  return typeof requested === "string" ? requested : null;
}
