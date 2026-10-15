ALTER TABLE sandboxes
ADD COLUMN auto_stop_minutes INTEGER,
ADD COLUMN auto_archive_minutes INTEGER,
ADD COLUMN auto_delete_minutes INTEGER,
ADD COLUMN ephemeral BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE sandbox_environment_variables (
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox_id, name)
);

ALTER TABLE compute_jobs DROP CONSTRAINT compute_jobs_operation_check;
ALTER TABLE compute_jobs
ADD CONSTRAINT compute_jobs_operation_check
CHECK (operation IN ('create', 'start', 'stop', 'delete', 'snapshot'));

ALTER TABLE compute_jobs
ADD COLUMN snapshot_id TEXT REFERENCES workspace_snapshots(id) ON DELETE CASCADE;
