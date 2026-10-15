ALTER TABLE environment_templates ADD COLUMN keep_preview_ready boolean NOT NULL DEFAULT false;
ALTER TABLE environment_templates ADD COLUMN prepared_environment_id text REFERENCES sandboxes(id) ON DELETE SET NULL;
ALTER TABLE environment_templates ADD COLUMN prepared_configuration jsonb;
ALTER TABLE environment_templates ADD COLUMN preview_pool_error text;
ALTER TABLE sandboxes ADD COLUMN preview_template_id text REFERENCES environment_templates(id) ON DELETE SET NULL;
ALTER TABLE sandboxes ADD COLUMN preview_claim_key text;
CREATE UNIQUE INDEX sandboxes_preview_claim_unique ON sandboxes (preview_template_id, preview_claim_key)
  WHERE preview_claim_key IS NOT NULL AND state <> 'deleted';
