ALTER TABLE sandboxes ADD COLUMN preview_id TEXT;
UPDATE sandboxes SET preview_id = replace(id, 'dev_', '') WHERE preview_id IS NULL;
ALTER TABLE sandboxes ALTER COLUMN preview_id SET NOT NULL;
ALTER TABLE sandboxes ADD CONSTRAINT sandboxes_preview_id_key UNIQUE (preview_id);

CREATE TABLE sandbox_ports (
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol TEXT NOT NULL DEFAULT 'http' CHECK (protocol IN ('http', 'https')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox_id, port)
);

CREATE INDEX sandbox_ports_last_seen_idx ON sandbox_ports (sandbox_id, last_seen_at DESC);
