ALTER TABLE sessions
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER finished_at,
  ADD INDEX idx_sessions_deleted_at (deleted_at);
