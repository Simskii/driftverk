DROP INDEX IF EXISTS compute_agents_one_active_per_organization_idx;
CREATE INDEX compute_agents_active_organization_idx ON compute_agents (organization_id) WHERE revoked_at IS NULL;
ALTER TABLE compute_agent_authorizations ADD COLUMN compute_node_id TEXT REFERENCES compute_agents(id);
ALTER TABLE compute_agents ADD COLUMN snapshot_storage_key TEXT;
ALTER TABLE compute_agents ADD COLUMN cpu_count INTEGER, ADD COLUMN memory_mb INTEGER;
ALTER TABLE workspace_snapshots ADD COLUMN storage_key TEXT;
-- Volumes are host-local until cross-host storage coordination is implemented.
ALTER TABLE workspace_volumes ADD COLUMN compute_node_id TEXT;
UPDATE workspace_volumes v SET compute_node_id = (
  SELECT s.compute_node_id FROM sandbox_volume_mounts m JOIN sandboxes s ON s.id = m.sandbox_id
  WHERE m.volume_id = v.id AND s.compute_node_id IS NOT NULL ORDER BY s.created_at LIMIT 1
);
