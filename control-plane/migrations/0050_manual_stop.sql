-- Explicit stops remain stopped until an explicit start. Idle stops remain wakeable.
ALTER TABLE sandboxes ADD COLUMN manual_stop boolean NOT NULL DEFAULT false;
