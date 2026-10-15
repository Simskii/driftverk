ALTER TABLE "user" ADD COLUMN terms_version text;
ALTER TABLE "user" ADD COLUMN terms_accepted_at timestamptz;

-- Existing users have not accepted these terms. Do not infer acceptance.
ALTER TABLE "user" ADD CONSTRAINT user_terms_acceptance_pair CHECK (
  (terms_version IS NULL AND terms_accepted_at IS NULL) OR
  (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL)
);
