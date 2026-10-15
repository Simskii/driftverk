CREATE TABLE organization_agents (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id text NOT NULL CHECK (agent_id IN ('codex', 'claude')),
  model text,
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, agent_id)
);
CREATE UNIQUE INDEX organization_agents_default_idx ON organization_agents(organization_id) WHERE is_default;
-- Resolve the selected profile at creation; later edits affect new environments only.
ALTER TABLE sandboxes ADD COLUMN agent_configuration jsonb;
