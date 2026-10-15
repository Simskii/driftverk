-- Personal connections are never organization secrets or snapshot contents.
CREATE TABLE user_agent_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  agent_id text NOT NULL CHECK (agent_id = 'codex'),
  encrypted_value text,
  iv text,
  generation text NOT NULL DEFAULT gen_random_uuid()::text,
  model text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_id)
);
CREATE TABLE user_agent_logins (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'connected', 'failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
