CREATE TABLE workspace_volumes (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_prefix text NOT NULL,
  created_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, storage_prefix)
);

CREATE TABLE sandbox_volume_mounts (
  sandbox_id text NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  volume_id text NOT NULL REFERENCES workspace_volumes(id) ON DELETE RESTRICT,
  mount_path text NOT NULL,
  subpath text NOT NULL DEFAULT '',
  read_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox_id, mount_path)
);

CREATE INDEX sandbox_volume_mounts_volume_id_idx ON sandbox_volume_mounts(volume_id);
