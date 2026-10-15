-- Platform-owned releases. Customer filesystem snapshots remain organization-scoped.
CREATE TABLE system_snapshots (
  id TEXT PRIMARY KEY CHECK (id ~ '^sys_[a-z0-9._-]+$'),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  image_ref TEXT NOT NULL CHECK (image_ref ~ '^ghcr.io/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$'),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX system_snapshots_one_default ON system_snapshots (is_default) WHERE is_default;
-- No seed: a release is registered only after its public digest has been verified.
