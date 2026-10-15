ALTER TABLE sandboxes ADD COLUMN runtime_probe_failures integer NOT NULL DEFAULT 0;
ALTER TABLE sandboxes ADD COLUMN runtime_probe_at timestamptz;
ALTER TABLE sandboxes ADD COLUMN runtime_recovery_at timestamptz;
