ALTER TABLE compute_agents ADD COLUMN health jsonb;
ALTER TABLE compute_agents ADD COLUMN health_checked_at timestamptz;
