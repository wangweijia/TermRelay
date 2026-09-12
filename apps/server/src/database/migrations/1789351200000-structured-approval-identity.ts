import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StructuredApprovalIdentity1789351200000 implements MigrationInterface {
  name = 'StructuredApprovalIdentity1789351200000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE approvals
        ADD COLUMN approval_key VARCHAR(256) NULL AFTER session_id,
        ADD COLUMN turn_ref VARCHAR(256) NULL AFTER approval_key,
        ADD COLUMN item_ref VARCHAR(256) NULL AFTER turn_ref
    `);
    await queryRunner.query(
      "UPDATE approvals SET approval_key = CONCAT('legacy:', id) WHERE approval_key IS NULL",
    );
    await queryRunner.query(`
      ALTER TABLE approvals
        MODIFY COLUMN approval_key VARCHAR(256) NOT NULL,
        ADD UNIQUE KEY uq_approvals_session_key (session_id, approval_key)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE approvals
        DROP INDEX uq_approvals_session_key,
        DROP COLUMN item_ref,
        DROP COLUMN turn_ref,
        DROP COLUMN approval_key
    `);
  }
}
