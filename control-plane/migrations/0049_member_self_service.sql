ALTER TABLE organizations
  ADD COLUMN member_creation_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN member_environment_cpu integer NOT NULL DEFAULT 1 CHECK (member_environment_cpu IN (1,2,4,8)),
  ADD COLUMN member_environment_memory_mb integer NOT NULL DEFAULT 2048 CHECK (member_environment_memory_mb IN (1024,2048,4096,8192,16384));

-- Distinct from creator and access assignments: an admin-assigned environment
-- never consumes a member's personal allowance. Pending deletion still counts.
ALTER TABLE sandboxes ADD COLUMN personal_owner_user_id text REFERENCES "user"(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX sandboxes_one_personal_environment
  ON sandboxes (organization_id, personal_owner_user_id)
  WHERE personal_owner_user_id IS NOT NULL AND state <> 'deleted';
