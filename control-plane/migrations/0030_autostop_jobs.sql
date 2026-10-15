-- Keep the stop reason on the durable job; telemetry logs expire after seven days.
ALTER TABLE compute_jobs ADD COLUMN auto_stop boolean NOT NULL DEFAULT false;
UPDATE compute_jobs j SET auto_stop = true
WHERE j.operation = 'stop' AND EXISTS (
  SELECT 1 FROM sandbox_logs l WHERE l.sandbox_id = j.sandbox_id AND l.event_hash = j.id || ':auto-stop'
);
