-- API key audit rows must remain valid after their key is revoked and removed.
-- OAuth rows persist their subject directly in oauth_subject.
ALTER TABLE api_audit_events DROP CONSTRAINT IF EXISTS api_audit_actor_present;
