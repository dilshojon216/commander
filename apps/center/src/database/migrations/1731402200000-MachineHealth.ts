import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Server salomatligi (3.8).
 *
 * `machine_health` (hypertable): har `agent.health` uchun bitta qator. PK (machine_id, ts) vaqt ustunini o'z ichiga oladi
 * (PLAN qat'iy qoida 8). `metrics` = agentd yuborgan yuk (delta bo'lsa faqat o'zgargan bo'limlar: hajm kichik); to'liq
 * birlashtirilgan holat `machine_health_latest` da. Kalit raqamlar (cpu, mem_pct, disk_max_pct) alohida ustun: grafik
 * va cagg jsonb'ni o'qimasin. Retention 14 kun.
 *
 * `machine_health_5m` (continuous aggregate): 5 daqiqalik o'rtacha/maksimum; 24 soat va 7 kun grafiklari shundan.
 * Refresh oynasi (3 kun) raw retention'dan (14 kun) kichik: raw o'chirilganda materializatsiya qilingan bucket'lar yo'qolmaydi.
 *
 * `machine_health_latest`: har mashina uchun oxirgi to'liq snapshot (delta shunga qo'shiladi; center qayta ishga tushsa ham saqlanadi).
 * `health_incidents`: ochiq/yopilgan hodisalar (Telegram "bir hodisa uchun bir marta" shundan). Ochiq hodisa uchun
 * (machine, kind, subject) noyob.
 */
export class MachineHealth1731402200000 implements MigrationInterface {
  name = 'MachineHealth1731402200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "machine_health" (
        "ts" timestamptz NOT NULL,
        "machine_id" uuid NOT NULL,
        "cpu" numeric(5, 1),
        "mem_pct" numeric(5, 1),
        "disk_max_pct" numeric(5, 1),
        "metrics" jsonb NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_machine_health" PRIMARY KEY ("machine_id", "ts"),
        CONSTRAINT "fk_machine_health_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_machine_health_pct" CHECK (
          ("cpu" IS NULL OR "cpu" BETWEEN 0 AND 100)
          AND ("mem_pct" IS NULL OR "mem_pct" BETWEEN 0 AND 100)
          AND ("disk_max_pct" IS NULL OR "disk_max_pct" BETWEEN 0 AND 100)
        )
      )
    `);
    await queryRunner.query(`SELECT create_hypertable('machine_health', 'ts', chunk_time_interval => INTERVAL '1 day')`);
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW "machine_health_5m"
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT time_bucket(INTERVAL '5 minutes', "ts") AS "bucket",
             "machine_id",
             avg("cpu")::numeric(5, 1)          AS "cpu_avg",
             max("cpu")                         AS "cpu_max",
             avg("mem_pct")::numeric(5, 1)      AS "mem_avg",
             max("mem_pct")                     AS "mem_max",
             max("disk_max_pct")                AS "disk_max",
             count(*)::bigint                   AS "samples"
        FROM "machine_health"
       GROUP BY 1, "machine_id"
      WITH NO DATA
    `);
    await queryRunner.query(`
      SELECT add_continuous_aggregate_policy('machine_health_5m',
        start_offset => INTERVAL '3 days', end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '5 minutes')
    `);
    await queryRunner.query(`SELECT add_retention_policy('machine_health', INTERVAL '14 days')`);

    await queryRunner.query(`
      CREATE TABLE "machine_health_latest" (
        "machine_id" uuid PRIMARY KEY,
        "ts" timestamptz NOT NULL,
        "snapshot" jsonb NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_machine_health_latest_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "health_incidents" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "machine_id" uuid NOT NULL,
        "kind" text NOT NULL,
        "subject" text NOT NULL DEFAULT '',
        "severity" text NOT NULL,
        "summary" text NOT NULL,
        "opened_at" timestamptz NOT NULL DEFAULT now(),
        "resolved_at" timestamptz,
        "notified_at" timestamptz,
        CONSTRAINT "fk_health_incidents_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_health_incidents_kind" CHECK ("kind" IN ('disk', 'memory', 'cpu', 'container', 'systemd', 'offline')),
        CONSTRAINT "chk_health_incidents_severity" CHECK ("severity" IN ('warn', 'critical'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_health_incidents_open" ON "health_incidents" ("machine_id", "kind", "subject") WHERE "resolved_at" IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX "idx_health_incidents_opened" ON "health_incidents" ("opened_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "health_incidents"`);
    await queryRunner.query(`DROP TABLE "machine_health_latest"`);
    await queryRunner.query(`SELECT remove_retention_policy('machine_health', if_exists => true)`);
    await queryRunner.query(`SELECT remove_continuous_aggregate_policy('machine_health_5m', if_exists => true)`);
    await queryRunner.query(`DROP MATERIALIZED VIEW "machine_health_5m"`);
    await queryRunner.query(`DROP TABLE "machine_health"`);
  }
}
