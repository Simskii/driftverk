ALTER TABLE billing_accounts ADD COLUMN low_balance_notice uuid;
ALTER TABLE billing_accounts ADD COLUMN empty_balance_notice uuid;
CREATE TABLE billing_notifications (
  notice_id uuid NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('low','empty')),
  email text NOT NULL,
  organization_name text NOT NULL,
  balance_ore numeric NOT NULL,
  sent_at timestamptz,
  attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notice_id,user_id)
);
CREATE FUNCTION billing_reset_notices() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_ore >= 500 THEN NEW.low_balance_notice := NULL; END IF;
  IF NEW.balance_ore > 0 THEN NEW.empty_balance_notice := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_reset_notices BEFORE UPDATE OF balance_ore ON billing_accounts
FOR EACH ROW EXECUTE FUNCTION billing_reset_notices();
