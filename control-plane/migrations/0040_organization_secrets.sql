CREATE TABLE organization_secrets (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, name)
);
ALTER TABLE sandboxes ADD COLUMN organization_secret_names TEXT[] NOT NULL DEFAULT '{}';
