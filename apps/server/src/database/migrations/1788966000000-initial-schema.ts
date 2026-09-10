import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1788966000000 implements MigrationInterface {
  name = 'InitialSchema1788966000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    const sql = readFileSync(join(__dirname, '0001_initial.sql'), 'utf8');
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) await queryRunner.query(statement);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'audit_logs',
      'approvals',
      'events',
      'commands',
      'sessions',
      'workspaces',
      'cli_tools',
      'devices',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
}
