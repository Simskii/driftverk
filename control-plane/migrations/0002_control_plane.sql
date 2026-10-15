CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  UNIQUE (user_id)
);

CREATE TABLE sandboxes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  runtime_class TEXT NOT NULL DEFAULT 'container' CHECK (runtime_class = 'container'),
  source_type TEXT NOT NULL CHECK (source_type IN ('image', 'snapshot')),
  source_image TEXT,
  snapshot_id TEXT,
  cpu_count INTEGER NOT NULL CHECK (cpu_count > 0),
  memory_mb INTEGER NOT NULL CHECK (memory_mb > 0),
  disk_gb INTEGER NOT NULL CHECK (disk_gb > 0),
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'running', 'stopped', 'degraded', 'deleted')),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'deleted')),
  provisioning_step TEXT NOT NULL DEFAULT 'allocating',
  runtime_id TEXT,
  compute_node_id TEXT,
  error_message TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  CHECK (
    (source_type = 'image' AND source_image IS NOT NULL AND snapshot_id IS NULL)
    OR (source_type = 'snapshot' AND source_image IS NULL AND snapshot_id IS NOT NULL)
  )
);

CREATE TABLE compute_jobs (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'start', 'stop', 'delete')),
  runtime_class TEXT NOT NULL DEFAULT 'container' CHECK (runtime_class = 'container'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'failed')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  provisioning_step TEXT NOT NULL DEFAULT 'allocating',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX compute_jobs_claim_idx
ON compute_jobs (runtime_class, created_at)
WHERE status IN ('queued', 'leased');

CREATE UNIQUE INDEX compute_jobs_one_active_per_sandbox_idx
ON compute_jobs (sandbox_id)
WHERE status IN ('queued', 'leased');

CREATE INDEX sandboxes_organization_created_idx
ON sandboxes (organization_id, created_at DESC)
WHERE state <> 'deleted';
