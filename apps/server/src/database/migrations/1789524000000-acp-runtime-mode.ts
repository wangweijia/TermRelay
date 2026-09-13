import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AcpRuntimeMode1789524000000 implements MigrationInterface {
  name = 'AcpRuntimeMode1789524000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM commands WHERE session_id IS NOT NULL');
    await queryRunner.query('DELETE FROM sessions');
    await queryRunner.query(`
      ALTER TABLE sessions
        MODIFY COLUMN runtime_mode ENUM('pty','acp') NOT NULL DEFAULT 'pty',
        DROP COLUMN web_display_mode
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM commands WHERE session_id IS NOT NULL');
    await queryRunner.query('DELETE FROM sessions');
    await queryRunner.query(`
      ALTER TABLE sessions
        MODIFY COLUMN runtime_mode ENUM('terminal','structured') NOT NULL DEFAULT 'terminal',
        ADD COLUMN web_display_mode ENUM('approval','full') NOT NULL DEFAULT 'full' AFTER runtime_mode
    `);
  }
}
