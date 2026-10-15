ALTER TABLE organizations
  ADD COLUMN slug TEXT,
  ADD COLUMN logo TEXT,
  ADD COLUMN metadata TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE organizations
SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || left(md5(id), 8)
WHERE slug IS NULL;

ALTER TABLE organizations ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX organizations_slug_uidx ON organizations (slug);

ALTER TABLE memberships ADD COLUMN id TEXT;
UPDATE memberships SET id = 'member_' || md5(organization_id || ':' || user_id) WHERE id IS NULL;
ALTER TABLE memberships ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX memberships_id_uidx ON memberships (id);
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_user_id_key;

ALTER TABLE "session" ADD COLUMN active_organization_id TEXT;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  inviter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX invitations_organization_status_idx ON invitations (organization_id, status);
CREATE INDEX invitations_email_idx ON invitations (email);
