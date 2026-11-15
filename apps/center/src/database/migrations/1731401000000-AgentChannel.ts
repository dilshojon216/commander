import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * agentd <-> center kanali (task 1.4).
 *
 * - `sessions.status` ga `awaiting_approval` qo'shiladi (PermissionRequest navbatda).
 * - `stale` HOLAT EMAS: mashina offline bo'lganda ochiq sessiyalarda `stale_since` qo'yiladi,
 *   `status` o'zgarmaydi (agentd qaytgach haqiqiy holat o'zi tiklanadi; "stale" bo'lgan sessiya
 *   qanday holatda ekani yo'qolmaydi). Mashina qaytganda yoki sessiya hodisasi kelganda NULL'ga qaytadi.
 * - `machines.online` + `connected_at`/`disconnected_at`: WS ulanish holati (heartbeat 60 s timeout).
 *   Markaz restartida barcha mashinalar offline deb belgilanadi (ulanishlar xotirada).
 * - `agentd_version`/`claude_version`: `auth.response` dan.
 * - `sessions.transcript_path`: hodisadagi `transcriptPath` (agentd transcript tailer uchun mashina-lokal yo'l).
 */
export class AgentChannel1731401000000 implements MigrationInterface {
  name = 'AgentChannel1731401000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_status"`);
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_status"
      CHECK ("status" IN ('idle', 'working', 'waiting', 'awaiting_approval', 'done', 'ended'))
    `);
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "stale_since" timestamptz`);
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "transcript_path" text`);
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_machine_open" ON "sessions" ("machine_id") WHERE "ended_at" IS NULL`,
    );

    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "online" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "connected_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "disconnected_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "agentd_version" text`);
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "claude_version" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "claude_version"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "agentd_version"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "disconnected_at"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "connected_at"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "online"`);

    await queryRunner.query(`DROP INDEX "idx_sessions_machine_open"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "transcript_path"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "stale_since"`);
    await queryRunner.query(`UPDATE "sessions" SET "status" = 'waiting' WHERE "status" = 'awaiting_approval'`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_status"`);
    await queryRunner.query(`
      ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_status"
      CHECK ("status" IN ('idle', 'working', 'waiting', 'done', 'ended'))
    `);
  }
}
