-- Public pricing uses a fixed $30 Cloud welcome credit. Existing ledger entries
-- and legacy SEK accounts remain unchanged.
CREATE OR REPLACE FUNCTION billing_welcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'admin'
     AND NOT EXISTS(SELECT 1 FROM memberships WHERE organization_id=NEW.organization_id AND user_id<>NEW.user_id)
     AND EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND hosting_mode='managed')
     AND EXISTS(SELECT 1 FROM "user" WHERE id=NEW.user_id AND "emailVerified"=true)
     AND EXISTS(SELECT 1 FROM billing_accounts WHERE organization_id=NEW.organization_id AND NOT complimentary AND currency='usd') THEN
    INSERT INTO billing_welcome_claims(user_id,email_key,organization_id)
      SELECT NEW.user_id,md5(lower(trim(email))),NEW.organization_id FROM "user" WHERE id=NEW.user_id ON CONFLICT DO NOTHING;
    IF FOUND THEN
      UPDATE billing_accounts SET balance_ore=balance_ore+3000 WHERE organization_id=NEW.organization_id;
      INSERT INTO billing_ledger(organization_id,amount_ore,kind,reference,description)
        VALUES(NEW.organization_id,3000,'welcome','welcome:'||NEW.organization_id,'$30 Cloud welcome credit');
    END IF;
  END IF;
  RETURN NEW;
END $$;
