DELETE FROM commands WHERE session_id IS NOT NULL;
DELETE FROM sessions;
ALTER TABLE sessions
  MODIFY COLUMN runtime_mode ENUM('pty','acp') NOT NULL DEFAULT 'pty',
  DROP COLUMN web_display_mode;
