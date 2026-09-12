ALTER TABLE approvals
  ADD COLUMN approval_key VARCHAR(256) NULL AFTER session_id,
  ADD COLUMN turn_ref VARCHAR(256) NULL AFTER approval_key,
  ADD COLUMN item_ref VARCHAR(256) NULL AFTER turn_ref;

UPDATE approvals SET approval_key = CONCAT('legacy:', id) WHERE approval_key IS NULL;

ALTER TABLE approvals
  MODIFY COLUMN approval_key VARCHAR(256) NOT NULL,
  ADD UNIQUE KEY uq_approvals_session_key (session_id, approval_key);
