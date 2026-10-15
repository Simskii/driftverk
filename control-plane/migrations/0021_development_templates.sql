ALTER TABLE sandboxes ADD COLUMN repository TEXT;
ALTER TABLE sandboxes ADD COLUMN repository_branch TEXT;
ALTER TABLE sandboxes ADD COLUMN setup_command TEXT;
ALTER TABLE sandboxes ADD COLUMN workspace_path TEXT;
CREATE TABLE workspace_github_connections (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE environment_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  configuration JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
