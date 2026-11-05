import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ControllerAuth1793836800000 implements MigrationInterface {
  name = 'ControllerAuth1793836800000';
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE controller_pairings (
      id CHAR(36) NOT NULL PRIMARY KEY,
      installation_id VARCHAR(128) NOT NULL,
      device_name VARCHAR(128) NOT NULL,
      app_version VARCHAR(64) NOT NULL,
      device_code_hash CHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL,
      device_ids JSON NOT NULL,
      approved_by VARCHAR(320) NULL,
      created_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      INDEX idx_controller_pending (status, created_at),
      INDEX idx_controller_installation (installation_id, status, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await runner.query(`CREATE TABLE controller_credentials (
      id CHAR(36) NOT NULL PRIMARY KEY,
      installation_id VARCHAR(128) NOT NULL,
      device_name VARCHAR(128) NOT NULL,
      secret_hash CHAR(64) NOT NULL,
      device_ids JSON NOT NULL,
      approved_by VARCHAR(320) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NULL DEFAULT NULL,
      last_used_at DATETIME(3) NULL,
      revoked_at DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE controller_credentials');
    await runner.query('DROP TABLE controller_pairings');
  }
}