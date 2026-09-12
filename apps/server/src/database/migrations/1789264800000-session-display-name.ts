import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionDisplayName1789264800000 implements MigrationInterface {
  name = 'SessionDisplayName1789264800000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const sql = readFileSync(
      join(__dirname, '0004_session_display_name.sql'),
      'utf8',
    );
    await queryRunner.query(sql.trim().replace(/;$/u, ''));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN display_name');
  }
}
