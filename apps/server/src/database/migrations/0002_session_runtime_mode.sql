ALTER TABLE sessions
  ADD COLUMN runtime_mode ENUM('terminal', 'structured') NOT NULL DEFAULT 'terminal'
  AFTER tool_key;
