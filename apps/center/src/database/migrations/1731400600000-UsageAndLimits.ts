import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vaqt qatorlari: `token_usage` va `limit_samples` hypertable'lari, token_usage
 * uchun continuous aggregate'lar (`usage_5m`, `usage_1h`) va policy'lar.
 *
 * token_usage:
 * - Har `api_request` uchun bitta qator. PII YO'Q: email/account/organization
 *   ustunlari ataylab mavjud emas (PLAN §13 S1: agentd ularni olib tashlaydi).
 * - Dedup kaliti PK `(machine_id, request_id, ts)`: hypertable'da unique
 *   constraint vaqt ustunini o'z ichiga olishi shart. Demak dedup faqat bir xil
 *   `ts` bilan kelgan takror uchun ishlaydi; agentd bitta request uchun har doim
 *   bir xil ts (API javobining vaqti) yuborishi kerak (OTel va transcript manbalari
 *   orasida ham). Ts bo'yicha farq qilsa, ikki qator bo'ladi.
 * - `session_id` text: Claude session id (OTel `session.id`), FK yo'q: usage
 *   sessiya qatoridan oldin kelishi mumkin. Bog'lash: sessions(machine_id, claude_session_id).
 *
 * Retention (PLAN §7): raw token_usage 30 kun, agregatlar doimiy. Cagg refresh
 * oynalari (start_offset) raw retention'dan kichik, shunda raw o'chirilganda
 * materialized bucket'lar qayta hisoblanib yo'qolmaydi.
 * limit_samples uchun PLAN retention aytmagan, shuning uchun yoqilmagan
 * (tavsiya: 90 kun, docs/PLAN.md §7).
 * Compression yoqilmagan (hajm kichik); tavsiya: 7 kundan keyin, segmentby machine_id.
 */
export class UsageAndLimits1731400600000 implements MigrationInterface {
  name = 'UsageAndLimits1731400600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "token_usage" (
        "ts" timestamptz NOT NULL,
        "machine_id" uuid NOT NULL,
        "request_id" text NOT NULL,
        "session_id" text,
        "prompt_id" text,
        "model" text NOT NULL,
        "input_tokens" bigint NOT NULL DEFAULT 0,
        "output_tokens" bigint NOT NULL DEFAULT 0,
        "cache_read_tokens" bigint NOT NULL DEFAULT 0,
        "cache_creation_tokens" bigint NOT NULL DEFAULT 0,
        "cost_usd" numeric(14, 6),
        "source" text NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_token_usage" PRIMARY KEY ("machine_id", "request_id", "ts"),
        CONSTRAINT "fk_token_usage_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_token_usage_source" CHECK ("source" IN ('otel', 'transcript')),
        CONSTRAINT "chk_token_usage_nonneg" CHECK (
          "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_creation_tokens" >= 0
        )
      )
    `);
    await queryRunner.query(`SELECT create_hypertable('token_usage', 'ts', chunk_time_interval => INTERVAL '7 days')`);
    await queryRunner.query(`CREATE INDEX "idx_token_usage_session" ON "token_usage" ("session_id", "ts" DESC) WHERE "session_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_token_usage_model_ts" ON "token_usage" ("model", "ts" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "limit_samples" (
        "ts" timestamptz NOT NULL,
        "machine_id" uuid NOT NULL,
        "session_id" text,
        "source" text NOT NULL,
        "five_hour_used_pct" numeric(6, 2),
        "five_hour_resets_at" timestamptz,
        "seven_day_used_pct" numeric(6, 2),
        "seven_day_resets_at" timestamptz,
        "calibration" jsonb,
        CONSTRAINT "pk_limit_samples" PRIMARY KEY ("machine_id", "source", "ts"),
        CONSTRAINT "fk_limit_samples_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_limit_samples_source" CHECK ("source" IN ('official', 'estimate')),
        CONSTRAINT "chk_limit_samples_pct" CHECK (
          ("five_hour_used_pct" IS NULL OR "five_hour_used_pct" >= 0)
          AND ("seven_day_used_pct" IS NULL OR "seven_day_used_pct" >= 0)
        ),
        CONSTRAINT "chk_limit_samples_any" CHECK (
          num_nonnulls("five_hour_used_pct", "five_hour_resets_at", "seven_day_used_pct", "seven_day_resets_at") > 0
        )
      )
    `);
    await queryRunner.query(`SELECT create_hypertable('limit_samples', 'ts', chunk_time_interval => INTERVAL '30 days')`);

    // Continuous aggregate'lar. WITH NO DATA: tranzaksiya ichida yaratish uchun
    // (jadval hozir bo'sh; policy ma'lumotni to'ldiradi).
    for (const [name, bucket] of [
      ['usage_5m', '5 minutes'],
      ['usage_1h', '1 hour'],
    ] as const) {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW "${name}"
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT time_bucket(INTERVAL '${bucket}', "ts") AS "bucket",
               "machine_id",
               "model",
               sum("input_tokens")::bigint          AS "input_tokens",
               sum("output_tokens")::bigint         AS "output_tokens",
               sum("cache_read_tokens")::bigint     AS "cache_read_tokens",
               sum("cache_creation_tokens")::bigint AS "cache_creation_tokens",
               sum("cost_usd")                      AS "cost_usd",
               count(*)::bigint                     AS "requests"
          FROM "token_usage"
         GROUP BY 1, "machine_id", "model"
        WITH NO DATA
      `);
    }
    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('usage_5m',
        start_offset => INTERVAL '7 days', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes')
    `);
    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('usage_1h',
        start_offset => INTERVAL '29 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour')
    `);
    await queryRunner.query(`SELECT add_retention_policy('token_usage', INTERVAL '30 days')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT remove_retention_policy('token_usage', if_exists => true)`);
    await queryRunner.query(`SELECT remove_continuous_aggregate_policy('usage_1h', if_exists => true)`);
    await queryRunner.query(`SELECT remove_continuous_aggregate_policy('usage_5m', if_exists => true)`);
    await queryRunner.query(`DROP MATERIALIZED VIEW "usage_1h"`);
    await queryRunner.query(`DROP MATERIALIZED VIEW "usage_5m"`);
    await queryRunner.query(`DROP TABLE "limit_samples"`);
    await queryRunner.query(`DROP TABLE "token_usage"`);
  }
}
