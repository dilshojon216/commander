import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Loyiha kesimidagi token statistikasi (kunlik va umrbod).
 *
 * Attribution (hech qanday qo'lda sozlashsiz):
 * - Loyiha = (machine_id, path) [UNIQUE]. `path` = git toplevel; git bo'lmasa cwd'ning
 *   o'zi (`kind='dir'`), shunda hech narsa atributsiyasiz qolmaydi. cwd noma'lum bo'lsa
 *   token_usage.project_id NULL ("noma'lum" bucket).
 * - `repo_key` = normallashtirilgan remote URL (masalan `github.com/org/repo`); bir repo
 *   Mac va Ubuntu'da bo'lsa, repo_key bo'yicha jamlanadi (`repo_token_totals`).
 * - Yangi cwd'dan birinchi sessiya/usage kelganda agentd/center `upsert_project(...)` ni
 *   chaqiradi: loyiha yaratiladi (yoki mavjud id qaytadi) va usage birinchi api_request'dan
 *   boshlab hisoblanadi. repo_key keyin ma'lum bo'lsa, COALESCE bilan to'ldiriladi.
 * - token_usage.project_id insert vaqtida denormalizatsiya qilinadi (sessions orqali join kerak emas).
 *
 * `token_usage_daily_by_project`: kun chegarasi Asia/Tashkent bo'yicha, real-time
 * (materialized_only=false: hali materializatsiya qilinmagan "bugun" so'rov vaqtida raw'dan
 * qo'shiladi). Policy: har 10 daqiqada, oyna [now-25d, now-1h]. 25 kun < raw retention (30 kun),
 * shuning uchun raw chunk'lar o'chirilganda materialized kunlar qayta hisoblanib yo'qolmaydi.
 * Bu cagg'ga retention policy QO'YILMAYDI: kunlik va umrbod statistika doimiy.
 * Cheklov: count(DISTINCT session_id) cagg'da qo'llanmaydi; sessiyalar soni `sessions` jadvalidan olinadi.
 */
export class ProjectUsageStats1731400800000 implements MigrationInterface {
  name = 'ProjectUsageStats1731400800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "repo_key" text`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "kind" text NOT NULL DEFAULT 'git'`);
    await queryRunner.query(`ALTER TABLE "projects" ADD CONSTRAINT "chk_projects_kind" CHECK ("kind" IN ('git', 'dir'))`);
    await queryRunner.query(`CREATE INDEX "idx_projects_repo_key" ON "projects" ("repo_key") WHERE "repo_key" IS NOT NULL`);

    await queryRunner.query(`ALTER TABLE "token_usage" ADD COLUMN "project_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "token_usage" ADD CONSTRAINT "fk_token_usage_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_token_usage_project_ts" ON "token_usage" ("project_id", "ts" DESC) WHERE "project_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION upsert_project(
        p_machine_id uuid, p_path text, p_repo_key text DEFAULT NULL, p_name text DEFAULT NULL, p_kind text DEFAULT 'git'
      ) RETURNS uuid
      LANGUAGE sql AS $$
        INSERT INTO "projects" ("machine_id", "path", "name", "repo_key", "kind")
        VALUES (
          p_machine_id, p_path,
          COALESCE(p_name, NULLIF((regexp_match(rtrim(p_path, '/'), '([^/]+)$'))[1], ''), p_path),
          p_repo_key, p_kind
        )
        ON CONFLICT ("machine_id", "path") DO UPDATE
          SET "repo_key" = COALESCE("projects"."repo_key", EXCLUDED."repo_key"),
              "kind" = CASE WHEN EXCLUDED."repo_key" IS NOT NULL THEN 'git' ELSE "projects"."kind" END
        RETURNING "id"
      $$
    `);

    await queryRunner.query(`
      CREATE MATERIALIZED VIEW "token_usage_daily_by_project"
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT time_bucket(INTERVAL '1 day', "ts", 'Asia/Tashkent') AS "day",
             "project_id",
             "model",
             sum("input_tokens")::bigint          AS "input_tokens",
             sum("output_tokens")::bigint         AS "output_tokens",
             sum("cache_read_tokens")::bigint     AS "cache_read_tokens",
             sum("cache_creation_tokens")::bigint AS "cache_creation_tokens",
             sum("cost_usd")                      AS "cost_usd",
             count(*)::bigint                     AS "requests"
        FROM "token_usage"
       GROUP BY 1, "project_id", "model"
      WITH NO DATA
    `);
    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('token_usage_daily_by_project',
        start_offset => INTERVAL '25 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '10 minutes')
    `);

    // Umrbod jami (loyiha bo'yicha). first/last_used_at kun aniqligida (kun boshi, Asia/Tashkent).
    await queryRunner.query(`
      CREATE VIEW "project_token_totals" AS
      SELECT d."project_id",
             p."machine_id", p."name", p."path", p."repo_key", p."kind",
             COALESCE(p."repo_key", d."project_id"::text, 'unknown') AS "project_key",
             min(d."day") AS "first_used_at",
             max(d."day") AS "last_used_at",
             sum(d."input_tokens")::bigint          AS "input_tokens",
             sum(d."output_tokens")::bigint         AS "output_tokens",
             sum(d."cache_read_tokens")::bigint     AS "cache_read_tokens",
             sum(d."cache_creation_tokens")::bigint AS "cache_creation_tokens",
             sum(d."cost_usd")                      AS "cost_usd",
             sum(d."requests")::bigint              AS "requests"
        FROM "token_usage_daily_by_project" d
        LEFT JOIN "projects" p ON p."id" = d."project_id"
       GROUP BY d."project_id", p."id"
    `);
    // Bir repo bir nechta mashinada: repo_key bo'yicha, bo'lmasa project id, project_id NULL -> 'unknown'.
    await queryRunner.query(`
      CREATE VIEW "repo_token_totals" AS
      SELECT "project_key",
             max("name") AS "name",
             count("project_id")::int AS "projects",
             min("first_used_at") AS "first_used_at",
             max("last_used_at") AS "last_used_at",
             sum("input_tokens")::bigint          AS "input_tokens",
             sum("output_tokens")::bigint         AS "output_tokens",
             sum("cache_read_tokens")::bigint     AS "cache_read_tokens",
             sum("cache_creation_tokens")::bigint AS "cache_creation_tokens",
             sum("cost_usd")                      AS "cost_usd",
             sum("requests")::bigint              AS "requests"
        FROM "project_token_totals"
       GROUP BY "project_key"
    `);
    await queryRunner.query(`
      CREATE VIEW "token_usage_daily_total" AS
      SELECT "day",
             sum("input_tokens")::bigint          AS "input_tokens",
             sum("output_tokens")::bigint         AS "output_tokens",
             sum("cache_read_tokens")::bigint     AS "cache_read_tokens",
             sum("cache_creation_tokens")::bigint AS "cache_creation_tokens",
             sum("cost_usd")                      AS "cost_usd",
             sum("requests")::bigint              AS "requests"
        FROM "token_usage_daily_by_project"
       GROUP BY "day"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW "token_usage_daily_total"`);
    await queryRunner.query(`DROP VIEW "repo_token_totals"`);
    await queryRunner.query(`DROP VIEW "project_token_totals"`);
    // Policy avval olib tashlanadi: ishlab turgan refresh job bilan DROP poygasi ("tuple concurrently deleted") bo'lmasin.
    await queryRunner.query(`SELECT remove_continuous_aggregate_policy('token_usage_daily_by_project', if_exists => true)`);
    await queryRunner.query(`DROP MATERIALIZED VIEW "token_usage_daily_by_project"`);
    await queryRunner.query(`DROP FUNCTION "upsert_project"(uuid, text, text, text, text)`);
    await queryRunner.query(`DROP INDEX "idx_token_usage_project_ts"`);
    await queryRunner.query(`ALTER TABLE "token_usage" DROP CONSTRAINT "fk_token_usage_project"`);
    await queryRunner.query(`ALTER TABLE "token_usage" DROP COLUMN "project_id"`);
    await queryRunner.query(`DROP INDEX "idx_projects_repo_key"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "chk_projects_kind"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "kind"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "repo_key"`);
  }
}
