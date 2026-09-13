import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NotificationSettings1789610400000 implements MigrationInterface {
  name = 'NotificationSettings1789610400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS notification_settings (
      setting_key VARCHAR(64) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await queryRunner.query(`INSERT INTO notification_settings (setting_key, enabled)
      VALUES ('bark_approval_push', FALSE)
      ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS notification_settings');
  }
}
