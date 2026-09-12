ALTER TABLE sessions
  ADD COLUMN display_name VARCHAR(128) NULL AFTER tool_key;
