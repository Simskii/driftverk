ALTER TABLE sandboxes
ADD COLUMN preview_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE workspace_github_connections
ADD COLUMN refresh_token_encrypted text,
ADD COLUMN refresh_token_iv text,
ADD COLUMN token_expires_at timestamptz,
ADD COLUMN connection_type text NOT NULL DEFAULT 'legacy_token'
  CHECK (connection_type IN ('legacy_token', 'github_app'));

CREATE TABLE github_oauth_states (
  state_hash text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  return_path text NOT NULL DEFAULT '/environments/new',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_oauth_states_expiry_idx ON github_oauth_states(expires_at);
