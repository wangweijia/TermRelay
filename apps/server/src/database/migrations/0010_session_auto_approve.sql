ALTER TABLE sessions
  ADD COLUMN auto_approve_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER state_version;
