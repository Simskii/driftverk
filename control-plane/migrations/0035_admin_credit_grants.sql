ALTER TABLE billing_ledger DROP CONSTRAINT billing_ledger_kind_check;
ALTER TABLE billing_ledger ADD CONSTRAINT billing_ledger_kind_check CHECK (kind IN ('welcome','purchase','usage','refund','grant'));
-- Keep the actor ID even if their user account is later removed.
ALTER TABLE billing_ledger ADD COLUMN granted_by_user_id text;
