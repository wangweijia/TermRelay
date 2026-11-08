import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TurnCommandConfirmation1793923200000 implements MigrationInterface {
  name = 'TurnCommandConfirmation1793923200000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE commands ADD COLUMN request_hash CHAR(64) NULL, ADD COLUMN acknowledgement JSON NULL');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE commands DROP COLUMN acknowledgement, DROP COLUMN request_hash');
  }
}
