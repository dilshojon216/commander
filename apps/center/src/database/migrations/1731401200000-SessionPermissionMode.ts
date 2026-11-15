import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessiyaning joriy ruxsat rejimi (hook `permission_mode`: `default`, `acceptEdits`, `plan`, `bypassPermissions`, ...).
 * NULL = noma'lum (eski sessiyalar, v0 hook). Faqat markaz ko'rsatadi; hech narsa boshqarilmaydi.
 */
export class SessionPermissionMode1731401200000 implements MigrationInterface {
  name = 'SessionPermissionMode1731401200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "permission_mode" text`);
    await queryRunner.query(`ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_permission_mode_len" CHECK ("permission_mode" IS NULL OR char_length("permission_mode") <= 32)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_permission_mode_len"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "permission_mode"`);
  }
}
