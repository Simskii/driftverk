-- Legacy workspace tokens have no recorded owner. Preserve them for rollback,
-- but require each user to reconnect rather than guessing who owns a token.
CREATE TABLE user_github_connections (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  login text NOT NULL,
  encrypted_token text NOT NULL,
  iv text NOT NULL,
  refresh_token_encrypted text,
  refresh_token_iv text,
  token_expires_at timestamptz,
  connection_type text NOT NULL DEFAULT 'legacy_token'
    CHECK (connection_type IN ('legacy_token', 'github_app')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep outstanding workspace authorizations separate from personal authorizations.
CREATE TABLE user_github_oauth_states (
  state_hash text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  return_path text NOT NULL DEFAULT '/environments/new',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_github_oauth_states_expiry_idx ON user_github_oauth_states(expires_at);
