CREATE TABLE installation_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  mode text NOT NULL CHECK(mode IN ('hosted','self-hosted'))
);

CREATE FUNCTION installation_self_hosted() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT mode='self-hosted' FROM installation_settings WHERE singleton),false)
$$;

-- Reuse the existing unmetered path in every billing policy. Enforce this in the
-- database so API/MCP/admin writes cannot accidentally reinstate paid access.
CREATE FUNCTION installation_billing_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF installation_self_hosted() THEN NEW.complimentary := true; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_billing_account BEFORE INSERT OR UPDATE ON billing_accounts
  FOR EACH ROW EXECUTE FUNCTION installation_billing_account();

CREATE FUNCTION installation_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF installation_self_hosted() THEN
    IF TG_OP='UPDATE' AND NEW.hosting_mode <> 'hybrid' THEN
      RAISE EXCEPTION 'Self-hosted installations use their own compute hosts';
    END IF;
    NEW.hosting_mode := 'hybrid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_organization BEFORE INSERT OR UPDATE OF hosting_mode ON organizations
  FOR EACH ROW EXECUTE FUNCTION installation_organization();
