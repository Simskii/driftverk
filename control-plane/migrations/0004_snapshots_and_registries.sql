CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
  kind TEXT NOT NULL DEFAULT 'filesystem' CHECK (kind IN ('base', 'filesystem')),
  base_image TEXT NOT NULL,
  source_sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE SET NULL,
  artifact_ref TEXT,
  snapshot_size_gb DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (organization_id, name, version)
);

CREATE INDEX workspace_snapshots_organization_created_idx
ON workspace_snapshots (organization_id, created_at DESC);

CREATE TABLE workspace_registries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (organization_id, url, username)
);

CREATE INDEX workspace_registries_organization_created_idx
ON workspace_registries (organization_id, created_at DESC);

ALTER TABLE sandboxes
ADD COLUMN source_registry_id TEXT REFERENCES workspace_registries(id) ON DELETE SET NULL;
