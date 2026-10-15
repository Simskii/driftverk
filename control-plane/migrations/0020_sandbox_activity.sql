ALTER TABLE sandboxes
ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX sandboxes_auto_stop_idx
ON sandboxes (last_activity_at)
WHERE state = 'running' AND desired_state = 'running' AND auto_stop_minutes IS NOT NULL;
