CREATE TABLE client_pairings (
  id CHAR(36) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  device_name VARCHAR(128) NOT NULL,
  app_version VARCHAR(64) NOT NULL,
  device_code_hash CHAR(64) NOT NULL,
  user_code_hash CHAR(64) NOT NULL,
  status ENUM('pending','approved','denied','consumed','expired') NOT NULL DEFAULT 'pending',
  approved_by VARCHAR(320) NULL,
  expires_at DATETIME(3) NOT NULL,
  approved_at DATETIME(3) NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_pairings_user_code_hash (user_code_hash),
  INDEX idx_client_pairings_device_created (device_id, created_at),
  INDEX idx_client_pairings_status_expires (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE device_credentials (
  id CHAR(36) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  secret_hash CHAR(64) NOT NULL,
  approved_by VARCHAR(320) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  INDEX idx_device_credentials_device (device_id, revoked_at),
  INDEX idx_device_credentials_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;