CREATE TABLE api_keys (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret_hash text NOT NULL,
  secret_prefix text NOT NULL,
  scopes text[] NOT NULL,
  created_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT api_keys_scopes_allowed CHECK (
    scopes @> ARRAY['read']::text[] AND scopes <@ ARRAY['read', 'write', 'delete']::text[]
  )
);

CREATE INDEX api_keys_organization_idx
ON api_keys (organization_id, created_at DESC);

CREATE TABLE api_idempotency_keys (
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, idempotency_key),
  CONSTRAINT api_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 200)
);

CREATE TABLE api_audit_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id text REFERENCES api_keys(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  action text NOT NULL,
  resource_id text,
  status integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_audit_events_organization_idx
ON api_audit_events (organization_id, created_at DESC);
