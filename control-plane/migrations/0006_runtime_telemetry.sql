CREATE TABLE sandbox_metrics (
  id BIGSERIAL PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  cpu_percent DOUBLE PRECISION NOT NULL,
  memory_usage_mb DOUBLE PRECISION NOT NULL,
  memory_percent DOUBLE PRECISION NOT NULL,
  filesystem_percent DOUBLE PRECISION NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_metrics_sandbox_recorded_idx
ON sandbox_metrics (sandbox_id, recorded_at DESC);

CREATE TABLE sandbox_logs (
  id BIGSERIAL PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  UNIQUE (sandbox_id, event_hash)
);

CREATE INDEX sandbox_logs_sandbox_recorded_idx
ON sandbox_logs (sandbox_id, recorded_at DESC);
