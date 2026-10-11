import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AIService1791590400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE ai_project_keys (
      id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE, grants JSON NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE
    ) ENGINE=InnoDB`);
    await q.query(`CREATE TABLE ai_resources (
      id VARCHAR(36) PRIMARY KEY, idempotency_scope VARCHAR(200) NOT NULL UNIQUE, data JSON NOT NULL
    ) ENGINE=InnoDB`);
    await q.query('CREATE TABLE ai_service_mutex (id INT PRIMARY KEY) ENGINE=InnoDB');
    await q.query('INSERT INTO ai_service_mutex VALUES (1)');
    await q.query("ALTER TABLE sessions ADD origin VARCHAR(16) NOT NULL DEFAULT 'local', ADD project_id VARCHAR(64) NULL, ADD ai_resource_id VARCHAR(36) NULL, ADD lifecycle VARCHAR(16) NULL");
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE sessions DROP origin, DROP project_id, DROP ai_resource_id, DROP lifecycle');
    await q.query('DROP TABLE ai_resources');
    await q.query('DROP TABLE ai_project_keys');
    await q.query('DROP TABLE ai_service_mutex');
  }
}
