ALTER TABLE organizations
  ADD COLUMN hosting_mode TEXT NOT NULL DEFAULT 'managed'
  CHECK (hosting_mode IN ('managed', 'hybrid'));

CREATE TABLE compute_agents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ,
  version TEXT,
  storage_driver TEXT CHECK (storage_driver IS NULL OR storage_driver IN ('local', 's3')),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE UNIQUE INDEX compute_agents_one_active_per_organization_idx
ON compute_agents (organization_id)
WHERE revoked_at IS NULL;

CREATE INDEX compute_agents_organization_created_idx
ON compute_agents (organization_id, created_at DESC);
