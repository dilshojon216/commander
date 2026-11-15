import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remote boshqaruv (2.3-2.7): `commands` jadvaliga `session.set_mode`, idempotentlik xeshi, dispatch nonce'i,
 * xato kodi/izohi, step-up bayrog'i; `machines`ga agentd e'lon qilgan lokal siyosat ko'rinishi (`control`).
 *
 *  - `commands.nonce` = klientning `Idempotency-Key`i (UNIQUE(requested_by_device_id, nonce) o'zgarmagan);
 *    `request_hash` = tana xeshi: bir xil kalit + boshqa tana = 409.
 *  - `dispatch_nonce` = agentga yuborilgan bir martalik nonce (imzo ichida); bir qator = bir dispatch.
 *  - Haqiqiy prompt matni DB'ga YOZILMAYDI: `payload` redakt qilingan nusxani saqlaydi (CLAUDE.md qoida 5).
 *  - `machines.control`: agentd heartbeat'idagi siyosat holati (yo'llarsiz); markaz uni o'zgartirmaydi, faqat ko'rsatadi.
 */
export class RemoteCommands1731401300000 implements MigrationInterface {
  name = 'RemoteCommands1731401300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
    await queryRunner.query(`
      ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK (
        "type" IN ('session.start', 'session.prompt', 'session.interrupt', 'session.stop', 'session.set_mode', 'agent.reconfigure')
      )`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "request_hash" text`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "dispatch_nonce" text`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "error_code" text`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "error_message" text`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "step_up_required" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_error_len" CHECK ("error_code" IS NULL OR char_length("error_code") <= 64)`);
    await queryRunner.query(`CREATE INDEX "idx_commands_created_at" ON "commands" ("created_at" DESC)`);

    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "control" jsonb`);
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "control_reported_at" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "control_reported_at"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "control"`);
    await queryRunner.query(`DROP INDEX "idx_commands_created_at"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_error_len"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "step_up_required"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "error_message"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "error_code"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "dispatch_nonce"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "request_hash"`);
    // `session.set_mode` yo'q eski CHECK'ga qaytish uchun shunday qatorlar o'chiriladi (audit_log saqlanadi).
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = 'session.set_mode'`);
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
    await queryRunner.query(`
      ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK (
        "type" IN ('session.start', 'session.prompt', 'session.interrupt', 'session.stop', 'agent.reconfigure')
      )`);
  }
}
