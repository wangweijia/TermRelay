import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionSoftDelete1789178400000 implements MigrationInterface {
  name = 'SessionSoftDelete1789178400000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const sql = readFileSync(
      join(__dirname, '0003_session_soft_delete.sql'),
      'utf8',
    );
    await queryRunner.query(sql.trim().replace(/;$/u, ''));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sessions DROP INDEX idx_sessions_deleted_at, DROP COLUMN deleted_at',
    );
  }
}
