ALTER TABLE sandboxes
ADD COLUMN code_trust text NOT NULL DEFAULT 'trusted',
ADD COLUMN has_ever_received_environment_secrets boolean NOT NULL DEFAULT true,
ADD COLUMN automation_id text,
ADD COLUMN source_revision text,
ADD CONSTRAINT sandboxes_code_trust_check CHECK (code_trust IN ('trusted', 'untrusted')),
ADD CONSTRAINT sandboxes_automation_source_check CHECK (
  (automation_id IS NULL AND source_revision IS NULL)
  OR (automation_id IS NOT NULL AND source_revision IS NOT NULL)
),
ADD CONSTRAINT sandboxes_automation_trust_check CHECK (
  automation_id IS NULL OR (code_trust = 'untrusted' AND has_ever_received_environment_secrets = false)
),
ADD CONSTRAINT sandboxes_automation_id_length CHECK (
  automation_id IS NULL OR char_length(automation_id) BETWEEN 1 AND 200
),
ADD CONSTRAINT sandboxes_source_revision_length CHECK (
  source_revision IS NULL OR char_length(source_revision) IN (40, 64)
);

CREATE UNIQUE INDEX sandboxes_automation_revision_idx
ON sandboxes (organization_id, automation_id, source_revision)
WHERE automation_id IS NOT NULL AND state <> 'deleted';

ALTER TABLE api_keys
ADD COLUMN automation_id_prefix text,
ADD CONSTRAINT api_keys_automation_id_prefix_check CHECK (
  automation_id_prefix IS NULL OR automation_id_prefix ~ '^github:[0-9]+:pr:$'
);
