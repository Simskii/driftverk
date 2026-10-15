ALTER TABLE sandboxes ADD COLUMN ssh_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE sandboxes ADD COLUMN tailscale_execution_id text;
ALTER TABLE sandboxes ADD COLUMN tailscale_configured boolean NOT NULL DEFAULT false;
CREATE INDEX sandboxes_tailscale_execution_idx ON sandboxes(tailscale_execution_id) WHERE tailscale_execution_id IS NOT NULL;
