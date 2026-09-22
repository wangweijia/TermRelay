import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionAutoApprove1789783200000 implements MigrationInterface {
  name = 'SessionAutoApprove1789783200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions
      ADD COLUMN auto_approve_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER state_version`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN auto_approve_enabled');
  }
}
