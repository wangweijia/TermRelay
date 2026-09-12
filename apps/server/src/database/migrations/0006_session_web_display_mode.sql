ALTER TABLE sessions
  ADD COLUMN web_display_mode ENUM('approval','full') NOT NULL DEFAULT 'full'
  AFTER runtime_mode;
