import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1731400000000 implements MigrationInterface {
  name = 'InitSchema1731400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "host" text NOT NULL,
        "session_id" text NOT NULL,
        "cwd" text NOT NULL,
        "project" text NOT NULL,
        "status" text NOT NULL,
        "message" text,
        "notification_type" text,
        "started_at" timestamptz NOT NULL,
        "status_since" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "ended_at" timestamptz,
        CONSTRAINT "pk_sessions" PRIMARY KEY ("host", "session_id"),
        CONSTRAINT "chk_sessions_status"
          CHECK ("status" IN ('idle', 'working', 'waiting', 'done', 'ended'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_sessions_last_seen_at" ON "sessions" ("last_seen_at" DESC)`,
    );
    await queryRunner.query(`
      CREATE TABLE "session_events" (
        "id" bigserial NOT NULL,
        "host" text NOT NULL,
        "session_id" text NOT NULL,
        "event" text NOT NULL,
        "status" text NOT NULL,
        "message" text,
        "client_ts" bigint NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_session_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_session_events_session_received"
         ON "session_events" ("host", "session_id", "received_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_session_events_session_received"`);
    await queryRunner.query(`DROP TABLE "session_events"`);
    await queryRunner.query(`DROP INDEX "idx_sessions_last_seen_at"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
  }
}
