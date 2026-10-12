import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UnifiedAIConversations1791820800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE ai_resources SET data = JSON_SET(
      data, '$.kind', 'conversation', '$.status', 'closed',
      '$.activeTurnId', NULL, '$.closeReason', 'legacy_job',
      '$.error', CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) IN ('succeeded', 'failed', 'cancelled')
        THEN JSON_EXTRACT(data, '$.error')
        ELSE JSON_OBJECT('code', 'lifecycle_upgraded', 'message', 'Legacy execution ended during upgrade', 'executionOutcome', 'unknown') END,
      '$.finishedAt', COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.finishedAt')), 'null'),
        DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
    ) WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) = 'job'`);
    await q.query(`UPDATE ai_resources SET data = JSON_REMOVE(
      JSON_SET(data, '$.expiresAt', NULL), '$.deadlineAt', '$.contextId'
    )`);
    await q.query('ALTER TABLE sessions DROP COLUMN lifecycle');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE sessions ADD lifecycle VARCHAR(16) NULL');
    await q.query("UPDATE sessions SET lifecycle = 'longLived' WHERE origin = 'external'");
    // Historical results stay normalized; rolling back cannot reopen an old runtime.
  }
}
