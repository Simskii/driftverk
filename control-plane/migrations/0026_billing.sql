-- Existing pilot organizations retain access. New organizations enter billing.
CREATE TABLE billing_accounts (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  complimentary boolean NOT NULL DEFAULT false,
  balance_ore numeric(20,6) NOT NULL DEFAULT 0,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  subscription_status text NOT NULL DEFAULT 'none',
  paid_until timestamptz,
  trial_ends_at timestamptz,
  setup_sandbox_id text,
  setup_started_at timestamptz,
  exhausted_at timestamptz,
  cpu_hour_ore numeric NOT NULL DEFAULT 50,
  ram_gb_hour_ore numeric NOT NULL DEFAULT 12.5,
  storage_gb_hour_ore numeric NOT NULL DEFAULT 0.14,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_accounts (organization_id, complimentary) SELECT id, true FROM organizations;
CREATE TABLE billing_ledger (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES billing_accounts(organization_id) ON DELETE CASCADE,
  amount_ore numeric(20,6) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('welcome','purchase','usage','refund')),
  reference text UNIQUE,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_ledger_org ON billing_ledger(organization_id, id DESC);
-- Intentionally not cascaded: deleting an organization does not reset eligibility.
CREATE TABLE billing_welcome_claims (user_id text PRIMARY KEY, email_key text UNIQUE NOT NULL, organization_id text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing_resources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES billing_accounts(organization_id) ON DELETE CASCADE,
  compute_hour_ore numeric NOT NULL DEFAULT 0,
  compute_until timestamptz NOT NULL DEFAULT now()+interval '90 seconds',
  storage_hour_ore numeric NOT NULL DEFAULT 0,
  reserved_hour_ore numeric NOT NULL DEFAULT 0,
  metered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_resources_org ON billing_resources(organization_id);
CREATE TABLE billing_stripe_events (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing_checkouts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES billing_accounts(organization_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hybrid','topup')),
  amount_ore integer NOT NULL,
  stripe_session_id text UNIQUE,
  url text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
ALTER TABLE sandboxes ADD COLUMN billing_compute_active boolean NOT NULL DEFAULT false;

CREATE FUNCTION billing_new_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_accounts(organization_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER billing_new_organization AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION billing_new_organization();

CREATE FUNCTION billing_welcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'admin' AND NOT EXISTS(SELECT 1 FROM memberships WHERE organization_id=NEW.organization_id AND user_id<>NEW.user_id) AND EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND hosting_mode='managed')
     AND EXISTS(SELECT 1 FROM "user" WHERE id=NEW.user_id AND "emailVerified"=true)
     AND EXISTS(SELECT 1 FROM billing_accounts WHERE organization_id=NEW.organization_id AND NOT complimentary) THEN
    INSERT INTO billing_welcome_claims(user_id,email_key,organization_id) SELECT NEW.user_id,md5(lower(trim(email))),NEW.organization_id FROM "user" WHERE id=NEW.user_id ON CONFLICT DO NOTHING;
    IF FOUND THEN
      UPDATE billing_accounts SET balance_ore=balance_ore+30000 WHERE organization_id=NEW.organization_id;
      INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description)
        VALUES(NEW.organization_id,30000,'welcome','welcome:'||NEW.organization_id,'300 SEK Cloud welcome credit');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_welcome AFTER INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION billing_welcome();

-- Serialize settlement and reservations on the account, never on a cached client balance.
CREATE FUNCTION billing_settle(org text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; charge numeric; actual numeric; tick timestamptz;
BEGIN
  SELECT * INTO a FROM billing_accounts WHERE organization_id=org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing billing account'; END IF;
  IF a.complimentary THEN RETURN; END IF;
  tick := clock_timestamp();
  SELECT COALESCE(sum((compute_hour_ore*GREATEST(0,extract(epoch FROM (LEAST(tick,compute_until)-metered_at)))+storage_hour_ore*GREATEST(0,extract(epoch FROM (tick-metered_at))))/3600),0)
    INTO charge FROM billing_resources WHERE organization_id=org;
  actual := LEAST(GREATEST(a.balance_ore,0), round(charge,6));
  IF actual > 0 THEN
    UPDATE billing_accounts SET balance_ore=balance_ore-actual WHERE organization_id=org;
    INSERT INTO billing_ledger(organization_id,amount_ore,kind,description) VALUES(org,-actual,'usage','Cloud compute and storage');
  END IF;
  UPDATE billing_resources SET metered_at=tick WHERE organization_id=org;
  UPDATE billing_accounts SET exhausted_at=CASE WHEN balance_ore<=0 THEN COALESCE(exhausted_at,now()) ELSE NULL END WHERE organization_id=org;
END $$;

CREATE FUNCTION billing_assert(org text, sandbox text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text; reserve numeric;
BEGIN
  PERFORM billing_settle(org);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=org;
  IF a.complimentary THEN RETURN; END IF;
  SELECT hosting_mode INTO mode FROM organizations WHERE id=org;
  IF mode='hybrid' THEN
    IF a.paid_until>now() OR a.trial_ends_at>now() THEN RETURN; END IF;
    IF a.trial_ends_at IS NULL AND sandbox IS NOT NULL AND a.setup_sandbox_id=sandbox AND a.setup_started_at>now()-interval '1 hour' THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE=CASE WHEN a.trial_ends_at IS NULL THEN 'Verify your first host in Compute hosts to start the 14-day trial.' ELSE 'Your Hybrid trial or subscription has ended. Open Billing to continue.' END;
  END IF;
  SELECT COALESCE(sum(reserved_hour_ore+storage_hour_ore),0)/60 INTO reserve FROM billing_resources WHERE organization_id=org;
  IF a.balance_ore <= GREATEST(reserve,1) THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Insufficient Cloud balance. Open Billing to add funds.';
  END IF;
END $$;

CREATE FUNCTION billing_sandbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text; running boolean; reserved boolean;
BEGIN
  PERFORM billing_settle(NEW.organization_id);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id;
  IF a.complimentary THEN RETURN NEW; END IF;
  SELECT hosting_mode INTO mode FROM organizations WHERE id=NEW.organization_id;
  IF mode='hybrid' THEN
    IF TG_OP='INSERT' AND a.trial_ends_at IS NULL AND a.paid_until IS NULL THEN
      IF (a.setup_sandbox_id IS NOT NULL AND EXISTS(SELECT 1 FROM sandboxes WHERE id=a.setup_sandbox_id AND state<>'deleted')) OR NEW.source_image<>'nginx:stable-alpine' OR NEW.source_type<>'image'
         OR NEW.cpu_count<>1 OR NEW.memory_mb<>2048 OR NEW.setup_command IS NOT NULL OR NEW.repository IS NOT NULL
         OR NEW.readiness_command IS NOT NULL OR NEW.source_registry_id IS NOT NULL OR NEW.disk_gb>40 OR NEW.startup_command IS NOT NULL OR NEW.initialization_command IS NOT NULL OR NEW.purpose<>'development' THEN
        RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Run Test host in Compute hosts to activate your Hybrid trial.';
      END IF;
      UPDATE billing_accounts SET setup_sandbox_id=NEW.id,setup_started_at=COALESCE(setup_started_at,now()) WHERE organization_id=NEW.organization_id;
      NEW.auto_stop_minutes := 5;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IN ('stopped','deleted') OR NEW.runtime_id IS NULL THEN NEW.billing_compute_active:=false; END IF;
  running := NEW.billing_compute_active AND NEW.state<>'deleted';
  reserved := NEW.desired_state='running' AND NEW.state NOT IN ('deleted','stopped');
  INSERT INTO billing_resources(id,organization_id,compute_hour_ore,storage_hour_ore,reserved_hour_ore)
    VALUES(NEW.id,NEW.organization_id,
      CASE WHEN running THEN NEW.cpu_count*a.cpu_hour_ore+NEW.memory_mb/1024.0*a.ram_gb_hour_ore ELSE 0 END,
      CASE WHEN NEW.runtime_id IS NOT NULL AND NEW.state<>'deleted' THEN NEW.disk_gb*a.storage_gb_hour_ore ELSE 0 END,
      CASE WHEN reserved THEN (NEW.cpu_count*a.cpu_hour_ore+NEW.memory_mb/1024.0*a.ram_gb_hour_ore+NEW.disk_gb*a.storage_gb_hour_ore)*CASE WHEN NEW.state='provisioning' THEN 35 ELSE 1 END ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET compute_until=clock_timestamp()+interval '90 seconds',compute_hour_ore=EXCLUDED.compute_hour_ore,storage_hour_ore=EXCLUDED.storage_hour_ore,reserved_hour_ore=EXCLUDED.reserved_hour_ore;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_sandbox BEFORE INSERT OR UPDATE OF state, desired_state, runtime_id, billing_compute_active, cpu_count, memory_mb, disk_gb ON sandboxes FOR EACH ROW EXECUTE FUNCTION billing_sandbox();

CREATE FUNCTION billing_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org text;
BEGIN
  IF NEW.operation IN ('create','start','snapshot') AND NEW.status IN ('queued','leased') THEN
    SELECT organization_id INTO org FROM sandboxes WHERE id=NEW.sandbox_id;
    PERFORM billing_assert(org,CASE WHEN NEW.operation='snapshot' THEN NULL ELSE NEW.sandbox_id END);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_job BEFORE INSERT OR UPDATE OF status ON compute_jobs FOR EACH ROW EXECUTE FUNCTION billing_job();

CREATE FUNCTION billing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts;
BEGIN
  PERFORM billing_settle(NEW.organization_id);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id;
  IF NOT a.complimentary AND EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND hosting_mode='managed') THEN
    INSERT INTO billing_resources(id,organization_id,storage_hour_ore)
      VALUES(NEW.id,NEW.organization_id,CASE WHEN NEW.status='ready' THEN NEW.snapshot_size_gb*a.storage_gb_hour_ore ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET storage_hour_ore=EXCLUDED.storage_hour_ore;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_snapshot BEFORE INSERT OR UPDATE OF status,snapshot_size_gb ON workspace_snapshots FOR EACH ROW EXECUTE FUNCTION billing_snapshot();

CREATE FUNCTION billing_host_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts;
BEGIN
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id FOR UPDATE;
  IF NOT a.complimentary AND (SELECT count(*) FROM compute_agents WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)>=2 THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Hybrid includes two connected hosts. Contact support for additional capacity.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_host_limit BEFORE INSERT ON compute_agents FOR EACH ROW EXECUTE FUNCTION billing_host_limit();

-- Hosting switches cannot leave paid resources or a subscription behind.
CREATE FUNCTION billing_hosting_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hosting_mode IS DISTINCT FROM OLD.hosting_mode AND EXISTS(
    SELECT 1 FROM billing_accounts WHERE organization_id=NEW.id AND NOT complimentary AND
      (stripe_subscription_id IS NOT NULL AND subscription_status NOT IN ('canceled','incomplete_expired','none') OR
       EXISTS(SELECT 1 FROM billing_resources WHERE organization_id=NEW.id AND compute_hour_ore+storage_hour_ore>0) OR
       EXISTS(SELECT 1 FROM billing_checkouts WHERE organization_id=NEW.id AND kind='hybrid' AND completed_at IS NULL AND expires_at>now()))) THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Cancel the subscription and remove stored Cloud resources before changing hosting.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_hosting_change BEFORE UPDATE OF hosting_mode ON organizations FOR EACH ROW EXECUTE FUNCTION billing_hosting_change();

ALTER TABLE workspace_volumes ADD COLUMN billing_size_gb numeric NOT NULL DEFAULT 0 CHECK(billing_size_gb>=0);
CREATE FUNCTION billing_volume() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts;
BEGIN
  PERFORM billing_settle(NEW.organization_id);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id;
  IF NOT a.complimentary AND EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND hosting_mode='managed') THEN
    IF TG_OP='INSERT' THEN PERFORM billing_assert(NEW.organization_id); END IF;
    INSERT INTO billing_resources(id,organization_id,storage_hour_ore) VALUES(NEW.id,NEW.organization_id,NEW.billing_size_gb*a.storage_gb_hour_ore)
      ON CONFLICT(id) DO UPDATE SET storage_hour_ore=EXCLUDED.storage_hour_ore;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_volume BEFORE INSERT OR UPDATE OF billing_size_gb ON workspace_volumes FOR EACH ROW EXECUTE FUNCTION billing_volume();

CREATE FUNCTION billing_access(org text, sandbox text, preview boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text;
BEGIN
 SELECT * INTO a FROM billing_accounts WHERE organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Billing account is unavailable'; END IF;
 IF a.complimentary THEN RETURN; END IF;
 SELECT hosting_mode INTO mode FROM organizations WHERE id=org;
 IF mode='hybrid' THEN
   IF GREATEST(a.paid_until,a.trial_ends_at)>now()-interval '3 days' THEN RETURN; END IF;
   IF preview AND a.trial_ends_at IS NULL AND a.setup_sandbox_id=sandbox AND a.setup_started_at>now()-interval '1 hour' THEN RETURN; END IF;
   RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Activate Hybrid in Billing to use terminal, SSH and executions. Your initial host preview remains available during setup.';
 END IF;
 IF a.balance_ore<=0 THEN RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Your Cloud balance is empty. Add funds in Billing to reconnect.'; END IF;
END $$;

CREATE FUNCTION billing_setup_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM billing_accounts WHERE setup_sandbox_id=NEW.sandbox_id AND trial_ends_at IS NULL AND paid_until IS NULL AND NOT complimentary) THEN
   RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Verify your host before configuring environments.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_setup_variables BEFORE INSERT OR UPDATE ON sandbox_environment_variables FOR EACH ROW EXECUTE FUNCTION billing_setup_configuration();
CREATE TRIGGER billing_setup_mounts BEFORE INSERT OR UPDATE ON sandbox_volume_mounts FOR EACH ROW EXECUTE FUNCTION billing_setup_configuration();
