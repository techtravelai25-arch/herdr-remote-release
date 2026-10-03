-- Keep the previous finite cap for a safe rollback to older Workers. Applying
-- this migration alone preserves the operator's existing admission settings.
ALTER TABLE beta_controls ADD COLUMN registration_unrestricted INTEGER NOT NULL DEFAULT 0
  CHECK (registration_unrestricted IN (0, 1));
