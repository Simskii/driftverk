-- Preserve existing SEK amounts and Stripe purchases; new accounts use public USD prices.
ALTER TABLE billing_accounts ADD COLUMN currency text NOT NULL DEFAULT 'sek' CHECK(currency IN ('sek','usd'));
ALTER TABLE billing_accounts ALTER COLUMN currency SET DEFAULT 'usd';
ALTER TABLE billing_accounts ADD COLUMN host_limit integer NOT NULL DEFAULT 2 CHECK(host_limit>=2 AND host_limit<=102);
ALTER TABLE billing_accounts ADD COLUMN pilot_approved_at timestamptz;
ALTER TABLE billing_accounts ADD COLUMN pilot_ends_at timestamptz;
ALTER TABLE billing_accounts ALTER COLUMN cpu_hour_ore SET DEFAULT 5;
ALTER TABLE billing_accounts ALTER COLUMN ram_gb_hour_ore SET DEFAULT 1.6;
ALTER TABLE billing_accounts ALTER COLUMN storage_gb_hour_ore SET DEFAULT 0.01;
ALTER TABLE billing_checkouts ADD COLUMN abandoned_at timestamptz;
ALTER TABLE billing_checkouts ADD COLUMN currency text NOT NULL DEFAULT 'sek' CHECK(currency IN ('sek','usd'));
ALTER TABLE billing_checkouts ALTER COLUMN currency SET DEFAULT 'usd';
ALTER TABLE billing_checkouts DROP CONSTRAINT billing_checkouts_kind_check;
ALTER TABLE billing_checkouts ADD CONSTRAINT billing_checkouts_kind_check CHECK(kind IN ('hybrid','pilot','topup'));

CREATE OR REPLACE FUNCTION billing_settle(org text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; charge numeric; actual numeric; tick timestamptz; storage_factor numeric;
BEGIN
  SELECT * INTO a FROM billing_accounts WHERE organization_id=org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing billing account'; END IF;
  IF a.complimentary THEN RETURN; END IF;
  tick := clock_timestamp();
  SELECT CASE WHEN a.currency='usd' AND sum(storage_hour_ore)>0
    THEN GREATEST(0,1-(5*a.storage_gb_hour_ore)/sum(storage_hour_ore)) ELSE 1 END
    INTO storage_factor FROM billing_resources WHERE organization_id=org;
  SELECT COALESCE(sum((compute_hour_ore*GREATEST(0,extract(epoch FROM (LEAST(tick,compute_until)-metered_at)))+storage_hour_ore*COALESCE(storage_factor,1)*GREATEST(0,extract(epoch FROM (tick-metered_at))))/3600),0)
    INTO charge FROM billing_resources WHERE organization_id=org;
  actual := LEAST(GREATEST(a.balance_ore,0), round(charge,6));
  IF actual > 0 THEN
    UPDATE billing_accounts SET balance_ore=balance_ore-actual WHERE organization_id=org;
    INSERT INTO billing_ledger(organization_id,amount_ore,kind,description) VALUES(org,-actual,'usage','Cloud compute and storage');
  END IF;
  UPDATE billing_resources SET metered_at=tick WHERE organization_id=org;
  UPDATE billing_accounts SET exhausted_at=CASE WHEN balance_ore<=0 THEN COALESCE(exhausted_at,now()) ELSE NULL END WHERE organization_id=org;
END $$;

CREATE OR REPLACE FUNCTION billing_assert(org text, sandbox text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text; reserve numeric;
BEGIN
  PERFORM billing_settle(org);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=org;
  IF a.complimentary THEN RETURN; END IF;
  SELECT hosting_mode INTO mode FROM organizations WHERE id=org;
  IF mode='hybrid' THEN
    IF a.paid_until>now() OR a.pilot_ends_at>now() OR a.trial_ends_at>now() THEN RETURN; END IF;
    IF a.trial_ends_at IS NULL AND sandbox IS NOT NULL AND a.setup_sandbox_id=sandbox AND a.setup_started_at>now()-interval '1 hour' THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE=CASE WHEN a.trial_ends_at IS NULL THEN 'Purchase Hybrid or arrange a paid pilot in Billing.' ELSE 'Your Hybrid access has ended. Open Billing to continue.' END;
  END IF;
  SELECT COALESCE(sum(reserved_hour_ore+storage_hour_ore),0)/60 INTO reserve FROM billing_resources WHERE organization_id=org;
  IF a.balance_ore <= GREATEST(reserve,1) THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Insufficient Cloud balance. Open Billing to add funds.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION billing_sandbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text; running boolean; reserved boolean;
BEGIN
  PERFORM billing_settle(NEW.organization_id);
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id;
  IF a.complimentary THEN RETURN NEW; END IF;
  SELECT hosting_mode INTO mode FROM organizations WHERE id=NEW.organization_id;
  IF mode='hybrid' THEN
    IF TG_OP='INSERT' AND a.trial_ends_at IS NULL AND a.paid_until IS NULL AND a.pilot_ends_at IS NULL THEN
      IF (a.setup_sandbox_id IS NOT NULL AND EXISTS(SELECT 1 FROM sandboxes WHERE id=a.setup_sandbox_id AND state<>'deleted')) OR NEW.source_image<>'nginx:stable-alpine' OR NEW.source_type<>'image'
         OR NEW.cpu_count<>1 OR NEW.memory_mb<>2048 OR NEW.setup_command IS NOT NULL OR NEW.repository IS NOT NULL
         OR NEW.readiness_command IS NOT NULL OR NEW.source_registry_id IS NOT NULL OR NEW.disk_gb>40 OR NEW.startup_command IS NOT NULL OR NEW.initialization_command IS NOT NULL OR NEW.purpose<>'development' THEN
        RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Run Test host in Compute hosts to verify your host before purchasing Hybrid.';
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

CREATE OR REPLACE FUNCTION billing_access(org text, sandbox text, preview boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; mode text;
BEGIN
 SELECT * INTO a FROM billing_accounts WHERE organization_id=org;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Billing account is unavailable'; END IF;
 IF a.complimentary THEN RETURN; END IF;
 SELECT hosting_mode INTO mode FROM organizations WHERE id=org;
 IF mode='hybrid' THEN
   IF GREATEST(a.paid_until,a.pilot_ends_at,a.trial_ends_at)>now()-interval '3 days' THEN RETURN; END IF;
   IF preview AND a.trial_ends_at IS NULL AND a.setup_sandbox_id=sandbox AND a.setup_started_at>now()-interval '1 hour' THEN RETURN; END IF;
   RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Activate Hybrid in Billing to use terminal, SSH and executions. Your initial host preview remains available during setup.';
 END IF;
 IF a.balance_ore<=0 THEN RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Your Cloud balance is empty. Add funds in Billing to reconnect.'; END IF;
END $$;

CREATE OR REPLACE FUNCTION billing_setup_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM billing_accounts WHERE setup_sandbox_id=NEW.sandbox_id AND trial_ends_at IS NULL AND paid_until IS NULL AND pilot_ends_at IS NULL AND NOT complimentary) THEN
   RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Verify your host before configuring environments.';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_host_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a billing_accounts;
BEGIN
  SELECT * INTO a FROM billing_accounts WHERE organization_id=NEW.organization_id FOR UPDATE;
  IF NOT a.complimentary AND (SELECT count(*) FROM compute_agents WHERE organization_id=NEW.organization_id AND revoked_at IS NULL)>=(CASE WHEN a.paid_until>now() THEN a.host_limit ELSE 2 END) THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Your connected-host limit is reached. Additional Hybrid hosts cost $49 per month; update your plan in Billing.';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_hosting_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hosting_mode IS DISTINCT FROM OLD.hosting_mode AND EXISTS(
    SELECT 1 FROM billing_accounts WHERE organization_id=NEW.id AND NOT complimentary AND
      (pilot_ends_at>now() OR stripe_subscription_id IS NOT NULL AND subscription_status NOT IN ('canceled','incomplete_expired','none') OR
       EXISTS(SELECT 1 FROM billing_resources WHERE organization_id=NEW.id AND compute_hour_ore+storage_hour_ore>0) OR
       EXISTS(SELECT 1 FROM billing_checkouts WHERE organization_id=NEW.id AND kind IN ('hybrid','pilot') AND completed_at IS NULL AND abandoned_at IS NULL))) THEN
    RAISE EXCEPTION USING ERRCODE='P0402', MESSAGE='Cancel the subscription and remove stored Cloud resources before changing hosting.';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE billing_exchange_rates (
  rate_date date PRIMARY KEY,
  usd_per_sek numeric NOT NULL CHECK(usd_per_sek>0),
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION billing_welcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit numeric; rate_date date; currency text;
BEGIN
  IF NEW.role = 'admin' AND NOT EXISTS(SELECT 1 FROM memberships WHERE organization_id=NEW.organization_id AND user_id<>NEW.user_id) AND EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND hosting_mode='managed')
     AND EXISTS(SELECT 1 FROM "user" WHERE id=NEW.user_id AND "emailVerified"=true)
     AND EXISTS(SELECT 1 FROM billing_accounts WHERE organization_id=NEW.organization_id AND NOT complimentary) THEN
    SELECT b.currency INTO currency FROM billing_accounts b WHERE organization_id=NEW.organization_id;
    credit := 30000;
    IF currency='usd' THEN
      SELECT round(30000*r.usd_per_sek),r.rate_date INTO credit,rate_date FROM billing_exchange_rates r WHERE r.rate_date>=current_date-7 ORDER BY r.rate_date DESC LIMIT 1;
      IF credit IS NULL THEN RAISE EXCEPTION 'A recent exchange rate is required for the 300 SEK welcome credit'; END IF;
    END IF;
    INSERT INTO billing_welcome_claims(user_id,email_key,organization_id) SELECT NEW.user_id,md5(lower(trim(email))),NEW.organization_id FROM "user" WHERE id=NEW.user_id ON CONFLICT DO NOTHING;
    IF FOUND THEN
      UPDATE billing_accounts SET balance_ore=balance_ore+credit WHERE organization_id=NEW.organization_id;
      INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description)
        VALUES(NEW.organization_id,credit,'welcome','welcome:'||NEW.organization_id,'300 SEK Cloud welcome credit'||CASE WHEN currency='usd' THEN ' converted to USD at ECB reference rate '||rate_date::text ELSE '' END);
    END IF;
  END IF;
  RETURN NEW;
END $$;
