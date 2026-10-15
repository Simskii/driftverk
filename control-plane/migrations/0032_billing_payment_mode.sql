-- One Stripe mode per database. Switching keys must not reuse test balances/customers.
CREATE TABLE billing_payment_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  livemode boolean NOT NULL
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM billing_checkouts WHERE stripe_session_id LIKE 'cs_test_%')
     AND EXISTS (SELECT 1 FROM billing_checkouts WHERE stripe_session_id LIKE 'cs_live_%') THEN
    RAISE EXCEPTION 'Mixed Stripe modes require billing reconciliation before migration';
  END IF;
END $$;
INSERT INTO billing_payment_mode(singleton,livemode)
SELECT true, bool_or(stripe_session_id LIKE 'cs_live_%') FROM billing_checkouts
WHERE stripe_session_id LIKE 'cs_test_%' OR stripe_session_id LIKE 'cs_live_%'
HAVING count(*) > 0;

ALTER TABLE billing_checkouts ADD COLUMN reconciled_at timestamptz;
