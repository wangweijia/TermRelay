import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AcpUserMessage1790553600000 implements MigrationInterface {
  name = 'AcpUserMessage1790553600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sessions
      ADD COLUMN has_user_message BOOLEAN NOT NULL DEFAULT FALSE AFTER auto_approve_enabled`);
    await queryRunner.query(`UPDATE sessions s SET s.has_user_message = TRUE
      WHERE s.runtime_mode = 'acp' AND (
        EXISTS (
          SELECT 1 FROM events e WHERE e.session_id = s.id
            AND e.type = 'tool.event'
            AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.kind')) = 'user.message'
        )
        OR s.state_version + 1 <> (
          SELECT COUNT(*) FROM events e WHERE e.session_id = s.id
        )
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE sessions DROP COLUMN has_user_message');
  }
}
