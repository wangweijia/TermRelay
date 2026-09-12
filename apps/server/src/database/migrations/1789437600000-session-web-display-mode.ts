import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionWebDisplayMode1789437600000 implements MigrationInterface {
  name = 'SessionWebDisplayMode1789437600000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const sql = readFileSync(join(__dirname, '0006_session_web_display_mode.sql'), 'utf8');
    await queryRunner.query(sql.trim().replace(/;$/u, ''));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN web_display_mode');
  }
}
