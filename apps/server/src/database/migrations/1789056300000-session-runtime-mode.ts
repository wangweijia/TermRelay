import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionRuntimeMode1789056300000 implements MigrationInterface {
  name = 'SessionRuntimeMode1789056300000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const sql = readFileSync(
      join(__dirname, '0002_session_runtime_mode.sql'),
      'utf8',
    );
    await queryRunner.query(sql.trim().replace(/;$/u, ''));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN runtime_mode');
  }
}
