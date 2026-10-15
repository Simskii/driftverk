DO $$
BEGIN
  IF to_regclass('public.compute_runners') IS NOT NULL
     AND to_regclass('public.compute_agents') IS NULL THEN
    ALTER TABLE compute_runners RENAME TO compute_agents;
  END IF;

  IF to_regclass('public.runner_device_authorizations') IS NOT NULL
     AND to_regclass('public.compute_agent_authorizations') IS NULL THEN
    ALTER TABLE runner_device_authorizations RENAME TO compute_agent_authorizations;
  END IF;
END $$;

ALTER INDEX IF EXISTS compute_runners_one_active_per_organization_idx
  RENAME TO compute_agents_one_active_per_organization_idx;
ALTER INDEX IF EXISTS compute_runners_organization_created_idx
  RENAME TO compute_agents_organization_created_idx;
ALTER INDEX IF EXISTS runner_device_authorizations_expires_idx
  RENAME TO compute_agent_authorizations_expires_idx;

UPDATE sandboxes
SET compute_node_id = 'agent_' || substring(compute_node_id FROM 8)
WHERE compute_node_id LIKE 'runner_%';

UPDATE compute_jobs
SET lease_owner = 'agent_' || substring(lease_owner FROM 8)
WHERE lease_owner LIKE 'runner_%';

UPDATE compute_agents
SET id = 'agent_' || substring(id FROM 8)
WHERE id LIKE 'runner_%';
