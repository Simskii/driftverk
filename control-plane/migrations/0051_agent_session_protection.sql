ALTER TABLE compute_jobs ADD COLUMN auto_delete boolean NOT NULL DEFAULT false;
UPDATE compute_jobs SET auto_delete=true WHERE operation='delete' AND EXISTS (
  SELECT 1 FROM sandbox_logs WHERE event_hash=compute_jobs.id || ':auto-delete'
);
CREATE TABLE agent_session_protections (
  sandbox_id text PRIMARY KEY REFERENCES sandboxes(id) ON DELETE CASCADE,
  id text NOT NULL UNIQUE,
  runtime_id text NOT NULL,
  identity text NOT NULL,
  socket text NOT NULL,
  status text NOT NULL CHECK (status IN ('launching','running','ended','expired','lost')),
  expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
