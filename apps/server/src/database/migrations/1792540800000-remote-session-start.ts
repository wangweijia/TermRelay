import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoteSessionStart1792540800000 implements MigrationInterface {
  name = 'RemoteSessionStart1792540800000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE workspaces ADD COLUMN launch_options JSON NULL');
    await runner.query(`CREATE TABLE session_starts (
      id CHAR(36) NOT NULL PRIMARY KEY,
      device_id VARCHAR(128) NOT NULL,
      request JSON NOT NULL,
      status ENUM('pending','accepted','completed','failed','unknown') NOT NULL,
      message VARCHAR(2048) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_session_starts_device_status (device_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE session_starts');
    await runner.query('ALTER TABLE workspaces DROP COLUMN launch_options');
  }
}
