CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(128) NOT NULL,
  name VARCHAR(128) NOT NULL,
  status ENUM('connected', 'connecting', 'offline', 'degraded') NOT NULL DEFAULT 'offline',
  capabilities JSON NOT NULL,
  app_version VARCHAR(64) NULL,
  last_seen_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_devices_status_last_seen (status, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS cli_tools (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(128) NOT NULL,
  tool_key VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  version VARCHAR(64) NULL,
  capabilities JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cli_tools_device_tool (device_id, tool_key),
  CONSTRAINT fk_cli_tools_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(128) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  available BOOLEAN NOT NULL DEFAULT FALSE,
  remote_start_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_workspaces_device (device_id),
  CONSTRAINT fk_workspaces_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(128) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  workspace_id VARCHAR(128) NOT NULL,
  tool_key VARCHAR(64) NOT NULL,
  status ENUM('starting', 'running', 'stopping', 'finished', 'failed') NOT NULL,
  state_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_sessions_device_status (device_id, status),
  INDEX idx_sessions_workspace (workspace_id),
  CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices(id),
  CONSTRAINT fk_sessions_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  command_id CHAR(36) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NULL,
  type VARCHAR(64) NOT NULL,
  status ENUM('pending', 'accepted', 'completed', 'rejected', 'failed') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_commands_command_id (command_id),
  INDEX idx_commands_device_created (device_id, created_at),
  CONSTRAINT fk_commands_device FOREIGN KEY (device_id) REFERENCES devices(id),
  CONSTRAINT fk_commands_session FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(128) NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_events_session_seq (session_id, seq),
  INDEX idx_events_expires (expires_at),
  CONSTRAINT fk_events_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS approvals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(128) NOT NULL,
  risk ENUM('low', 'medium', 'high', 'critical') NOT NULL,
  request JSON NOT NULL,
  decision ENUM('pending', 'approved', 'denied', 'expired') NOT NULL DEFAULT 'pending',
  decided_by VARCHAR(255) NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  INDEX idx_approvals_decision_expires (decision, expires_at),
  CONSTRAINT fk_approvals_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor VARCHAR(255) NOT NULL,
  action VARCHAR(128) NOT NULL,
  target VARCHAR(255) NOT NULL,
  result VARCHAR(64) NOT NULL,
  trace_id CHAR(36) NOT NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_audit_actor_created (actor, created_at),
  INDEX idx_audit_trace (trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
