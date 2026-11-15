import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v0 `sessions` / `session_events` jadvallarini `*_v0` ga o'zgartiradi (nomlar,
 * indekslar, constraint'lar va ketma-ketlik bilan), shunda v2 jadvallar o'z
 * nomlarini oladi. Ma'lumot keyingi migratsiyada ko'chiriladi; `*_v0` jadvallar
 * saqlanadi (rollback manbai) va keyinroq alohida DROP migratsiyasi bilan
 * o'chiriladi.
 */
export class RenameV0Sessions1731400200000 implements MigrationInterface {
  name = 'RenameV0Sessions1731400200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" RENAME TO "sessions_v0"`);
    await queryRunner.query(`ALTER TABLE "sessions_v0" RENAME CONSTRAINT "pk_sessions" TO "pk_sessions_v0"`);
    await queryRunner.query(`ALTER TABLE "sessions_v0" RENAME CONSTRAINT "chk_sessions_status" TO "chk_sessions_v0_status"`);
    await queryRunner.query(`ALTER INDEX "idx_sessions_last_seen_at" RENAME TO "idx_sessions_v0_last_seen_at"`);

    await queryRunner.query(`ALTER TABLE "session_events" RENAME TO "session_events_v0"`);
    await queryRunner.query(`ALTER TABLE "session_events_v0" RENAME CONSTRAINT "pk_session_events" TO "pk_session_events_v0"`);
    await queryRunner.query(`ALTER INDEX "idx_session_events_session_received" RENAME TO "idx_session_events_v0_session_received"`);
    await queryRunner.query(`ALTER SEQUENCE "session_events_id_seq" RENAME TO "session_events_v0_id_seq"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER SEQUENCE "session_events_v0_id_seq" RENAME TO "session_events_id_seq"`);
    await queryRunner.query(`ALTER INDEX "idx_session_events_v0_session_received" RENAME TO "idx_session_events_session_received"`);
    await queryRunner.query(`ALTER TABLE "session_events_v0" RENAME CONSTRAINT "pk_session_events_v0" TO "pk_session_events"`);
    await queryRunner.query(`ALTER TABLE "session_events_v0" RENAME TO "session_events"`);

    await queryRunner.query(`ALTER INDEX "idx_sessions_v0_last_seen_at" RENAME TO "idx_sessions_last_seen_at"`);
    await queryRunner.query(`ALTER TABLE "sessions_v0" RENAME CONSTRAINT "chk_sessions_v0_status" TO "chk_sessions_status"`);
    await queryRunner.query(`ALTER TABLE "sessions_v0" RENAME CONSTRAINT "pk_sessions_v0" TO "pk_sessions"`);
    await queryRunner.query(`ALTER TABLE "sessions_v0" RENAME TO "sessions"`);
  }
}
