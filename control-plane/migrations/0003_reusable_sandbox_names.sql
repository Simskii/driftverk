ALTER TABLE sandboxes
DROP CONSTRAINT sandboxes_organization_id_name_key;

CREATE UNIQUE INDEX sandboxes_organization_name_active_uidx
ON sandboxes (organization_id, name)
WHERE state <> 'deleted';
