ALTER TABLE sandboxes ADD COLUMN purpose text NOT NULL DEFAULT 'development' CHECK (purpose IN ('development', 'prebuild'));
ALTER TABLE sandboxes ADD COLUMN prebuild_id text;
ALTER TABLE sandboxes ADD COLUMN repository_revision text;
ALTER TABLE sandboxes ADD COLUMN initialization_command text;
CREATE TABLE project_prebuilds (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id text REFERENCES environment_templates(id) ON DELETE SET NULL,
  sandbox_id text NOT NULL UNIQUE REFERENCES sandboxes(id),
  snapshot_id text NOT NULL UNIQUE REFERENCES workspace_snapshots(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','failed')),
  configuration jsonb NOT NULL,
  repository_revision text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX project_prebuild_one_build ON project_prebuilds(template_id) WHERE status = 'building';
CREATE INDEX project_prebuild_org ON project_prebuilds(organization_id, created_at DESC);
ALTER TABLE sandboxes ADD CONSTRAINT sandbox_prebuild_fk FOREIGN KEY (prebuild_id) REFERENCES project_prebuilds(id);
CREATE TABLE sandbox_executions (
  id text PRIMARY KEY,
  sandbox_id text NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  compute_node_id text NOT NULL,
  command text NOT NULL,
  cwd text NOT NULL,
  timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 3600),
  artifact_paths jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out','output_limit','lost')),
  cancel_requested boolean NOT NULL DEFAULT false,
  exit_code integer,
  stdout_bytes integer NOT NULL DEFAULT 0,
  stderr_bytes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX executions_poll ON sandbox_executions(compute_node_id, updated_at) WHERE status IN ('queued','running');
CREATE INDEX executions_environment ON sandbox_executions(sandbox_id, created_at DESC);
CREATE TABLE execution_output (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execution_id text NOT NULL REFERENCES sandbox_executions(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('stdout','stderr')),
  byte_offset integer NOT NULL,
  data bytea NOT NULL,
  UNIQUE (execution_id, stream, byte_offset)
);
CREATE TABLE execution_artifacts (
  execution_id text NOT NULL REFERENCES sandbox_executions(id) ON DELETE CASCADE,
  path text NOT NULL,
  data bytea,
  error text,
  PRIMARY KEY (execution_id, path)
);
