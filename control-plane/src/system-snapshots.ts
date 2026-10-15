import type { Pool, PoolClient } from "pg";
import { db } from "./db.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export async function listSystemSnapshots(client: Queryable = db) {
  return (await client.query(`SELECT id, name, version, image_ref AS base_image, is_default,
    true AS is_system, 'ready' AS status, 'base' AS kind, NULL AS source_sandbox_id,
    0 AS snapshot_size_gb, NULL AS error_message, created_at, NULL AS last_used_at
    FROM system_snapshots ORDER BY is_default DESC, created_at DESC`)).rows;
}

// Translate the catalog selection to the existing portable image path. Persisting
// the digest in source_image also pins saved project setups and later restarts.
export async function resolveSystemSnapshot(input: Record<string, unknown>, client: Queryable = db): Promise<Record<string, unknown>> {
  const id = input.source_type === "snapshot" ? String(input.snapshot_id ?? "") : "";
  if (!id.startsWith("sys_")) return input;
  if (input.registry_id || input.image) throw new Error("A system snapshot cannot be combined with an image or registry");
  const result = await client.query<{ image_ref: string }>("SELECT image_ref FROM system_snapshots WHERE id = $1", [id]);
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error("System snapshot does not exist");
  return { ...input, source_type: "image", image: snapshot.image_ref, snapshot_id: undefined, registry_id: undefined };
}
