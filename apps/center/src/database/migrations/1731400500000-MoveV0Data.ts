import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DATA migratsiyasi: `sessions_v0` / `session_events_v0` -> v2.
 *
 * - Har bir noyob v0 `host` uchun `machines` qatori (identity_status =
 *   'legacy_unverified', legacy_host = host). Hostname identity EMAS; bu faqat
 *   v0 ma'lumotni bog'lash uchun vaqtinchalik kalit.
 * - session_events.id saqlanadi (v0 API `id`si o'zgarmasin), vaqt = received_at.
 * - Idempotent: qayta ishga tushirilsa ON CONFLICT DO NOTHING.
 * - v0 jadvallar o'zgarmaydi. down(): v2 dagi hozirgi holatni v0 jadvallarga
 *   qayta yozadi (v0 ni to'liq almashtiradi), shunda rollback yangi yozuvlarni yo'qotmaydi.
 */
export class MoveV0Data1731400500000 implements MigrationInterface {
  name = 'MoveV0Data1731400500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "machines" ("slug", "hostname", "legacy_host", "identity_status", "created_at", "last_seen_at")
      SELECT commander_machine_slug(h.host), h.host, h.host, 'legacy_unverified', h.first_seen, h.last_seen
      FROM (
        SELECT "host", min("started_at") AS first_seen, max("last_seen_at") AS last_seen
          FROM "sessions_v0" GROUP BY "host"
        UNION ALL
        SELECT e."host", min(e."received_at"), max(e."received_at")
          FROM "session_events_v0" e
         WHERE NOT EXISTS (SELECT 1 FROM "sessions_v0" s WHERE s."host" = e."host")
         GROUP BY e."host"
      ) h
      ON CONFLICT ("legacy_host") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "sessions" (
        "machine_id", "claude_session_id", "cwd", "project", "status", "message", "notification_type",
        "started_at", "status_since", "last_seen_at", "ended_at"
      )
      SELECT m."id", v."session_id", v."cwd", v."project", v."status", v."message", v."notification_type",
             v."started_at", v."status_since", v."last_seen_at", v."ended_at"
        FROM "sessions_v0" v
        JOIN "machines" m ON m."legacy_host" = v."host"
      ON CONFLICT ("machine_id", "claude_session_id") DO NOTHING
    `);

    // v0 event'lari sessiyasiz qolgan bo'lsa (v0 da FK yo'q), sessiya qatori tiklanadi.
    await queryRunner.query(`
      INSERT INTO "sessions" (
        "machine_id", "claude_session_id", "cwd", "project", "status",
        "started_at", "status_since", "last_seen_at"
      )
      SELECT m."id", e."session_id", '(unknown)', '(unknown)', (array_agg(e."status" ORDER BY e."received_at" DESC))[1],
             min(e."received_at"), max(e."received_at"), max(e."received_at")
        FROM "session_events_v0" e
        JOIN "machines" m ON m."legacy_host" = e."host"
       GROUP BY m."id", e."session_id"
      ON CONFLICT ("machine_id", "claude_session_id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "session_events" ("id", "ts", "session_id", "machine_id", "event", "status", "message", "client_ts")
      OVERRIDING SYSTEM VALUE
      SELECT e."id", e."received_at", s."id", s."machine_id", e."event", e."status", e."message", e."client_ts"
        FROM "session_events_v0" e
        JOIN "machines" m ON m."legacy_host" = e."host"
        JOIN "sessions" s ON s."machine_id" = m."id" AND s."claude_session_id" = e."session_id"
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      SELECT setval(
        pg_get_serial_sequence('session_events', 'id'),
        COALESCE((SELECT max("id") FROM "session_events"), 0) + 1,
        false
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "session_events_v0"`);
    await queryRunner.query(`DELETE FROM "sessions_v0"`);

    await queryRunner.query(`
      INSERT INTO "sessions_v0" (
        "host", "session_id", "cwd", "project", "status", "message", "notification_type",
        "started_at", "status_since", "last_seen_at", "ended_at"
      )
      SELECT COALESCE(m."legacy_host", m."hostname", m."slug"), s."claude_session_id", s."cwd", s."project",
             s."status", s."message", s."notification_type",
             s."started_at", s."status_since", s."last_seen_at", s."ended_at"
        FROM "sessions" s JOIN "machines" m ON m."id" = s."machine_id"
    `);
    await queryRunner.query(`
      INSERT INTO "session_events_v0" ("id", "host", "session_id", "event", "status", "message", "client_ts", "received_at")
      SELECT e."id", COALESCE(m."legacy_host", m."hostname", m."slug"), s."claude_session_id", e."event", e."status",
             e."message", COALESCE(e."client_ts", (extract(epoch FROM e."ts") * 1000)::bigint), e."ts"
        FROM "session_events" e
        JOIN "sessions" s ON s."id" = e."session_id"
        JOIN "machines" m ON m."id" = s."machine_id"
    `);
    await queryRunner.query(`
      SELECT setval(
        pg_get_serial_sequence('session_events_v0', 'id'),
        COALESCE((SELECT max("id") FROM "session_events_v0"), 0) + 1,
        false
      )
    `);
  }
}
