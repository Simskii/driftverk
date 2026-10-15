ALTER TABLE sandboxes ADD COLUMN preview_port INTEGER CHECK (preview_port BETWEEN 1 AND 65535);
ALTER TABLE workspace_snapshots ADD COLUMN launch_configuration JSONB;
