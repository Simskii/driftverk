-- Members start with no environment access. Organization creators already use the admin role.
CREATE TABLE environment_members (
  sandbox_id text NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  membership_id text NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sandbox_id, membership_id)
);
CREATE INDEX environment_members_membership_idx ON environment_members(membership_id);

CREATE FUNCTION can_access_environment(environment_id text, actor_user_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM sandboxes s
    JOIN memberships m ON m.organization_id = s.organization_id
    WHERE s.id = environment_id AND m.user_id = actor_user_id
      AND s.state <> 'deleted' AND s.desired_state <> 'deleted'
      AND (m.role IN ('admin', 'owner') OR EXISTS (
        SELECT 1 FROM environment_members em
        WHERE em.sandbox_id = s.id AND em.membership_id = m.id
      ))
  );
$$;
