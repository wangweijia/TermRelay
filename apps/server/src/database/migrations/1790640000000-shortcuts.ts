import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Shortcuts1790640000000 implements MigrationInterface {
  name = 'Shortcuts1790640000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE shortcuts (
      id CHAR(36) NOT NULL PRIMARY KEY,
      device_id VARCHAR(128) NOT NULL,
      revision BIGINT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(2048) NOT NULL,
      workspace_id VARCHAR(128) NOT NULL,
      proxy_mode ENUM('inherit','disabled','custom') NOT NULL,
      requires_confirmation BOOLEAN NOT NULL,
      INDEX idx_shortcuts_device (device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await queryRunner.query(`CREATE TABLE shortcut_runs (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shortcut_id CHAR(36) NOT NULL,
      device_id VARCHAR(128) NOT NULL,
      status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL,
      exit_code INT NULL,
      output MEDIUMTEXT NOT NULL,
      active_shortcut_id CHAR(36) NULL,
      cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_shortcut_runs_active (active_shortcut_id),
      INDEX idx_shortcut_runs_device_status (device_id, status),
      INDEX idx_shortcut_runs_status_updated (status, updated_at),
      INDEX idx_shortcut_runs_recent (created_at DESC, id DESC),
      INDEX idx_shortcut_runs_shortcut (shortcut_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE shortcut_runs');
    await queryRunner.query('DROP TABLE shortcuts');
  }
}
