import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 3.2 Watchdog va 3.3 Hisobotlar.
 *
 * - `watchdog_alerts`: qotib qolgan / ortiqcha sarf / xato takrori ogohlantirishlari. Bir sessiya + tur uchun bitta
 *   OCHIQ qator (qisman UNIQUE indeks): ogohlantirish bo'roni DB darajasida ham to'siladi. `episode_key` — "epizod" kaliti
 *   (waiting: `status_since`, error_loop: xato xeshi, burn: bo'sh); `payload` faqat raqam/xesh (matn saqlanmaydi).
 * - `reports`: kunlik/haftalik hisobot arxivi. `period_start` = Toshkent kuni (date); (kind, period_start) UNIQUE.
 *   `data` = tuzilgan hisobot (JSON), `text_html` = Telegram'ga yuborilgan matn (<= 16 KB), `sent_at` = yuborilgan vaqt.
 */
export class WatchdogReports1731402100000 implements MigrationInterface {
  name = 'WatchdogReports1731402100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "watchdog_alerts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" text NOT NULL,
        "state" text NOT NULL DEFAULT 'open',
        "session_id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "project_id" uuid,
        "episode_key" text NOT NULL DEFAULT '',
        "title" text NOT NULL,
        "detail" text NOT NULL DEFAULT '',
        "payload" jsonb NOT NULL DEFAULT '{}',
        "reminders_sent" integer NOT NULL DEFAULT 0,
        "last_notified_at" timestamptz,
        "auto_stopped" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "resolved_at" timestamptz,
        CONSTRAINT "pk_watchdog_alerts" PRIMARY KEY ("id"),
        CONSTRAINT "fk_watchdog_alerts_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_watchdog_alerts_kind" CHECK ("kind" IN ('waiting', 'burn', 'error_loop')),
        CONSTRAINT "chk_watchdog_alerts_state" CHECK ("state" IN ('open', 'resolved', 'dismissed')),
        CONSTRAINT "chk_watchdog_alerts_resolved" CHECK (("state" = 'open') = ("resolved_at" IS NULL)),
        CONSTRAINT "chk_watchdog_alerts_reminders" CHECK ("reminders_sent" BETWEEN 0 AND 10)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_watchdog_alerts_open" ON "watchdog_alerts" ("session_id", "kind") WHERE "state" = 'open'`);
    await queryRunner.query(`CREATE INDEX "idx_watchdog_alerts_created" ON "watchdog_alerts" ("created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_watchdog_alerts_session_kind" ON "watchdog_alerts" ("session_id", "kind", "created_at" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "reports" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" text NOT NULL,
        "period_start" date NOT NULL,
        "period_end" date NOT NULL,
        "data" jsonb NOT NULL,
        "text_html" text NOT NULL DEFAULT '',
        "generated_at" timestamptz NOT NULL DEFAULT now(),
        "sent_at" timestamptz,
        CONSTRAINT "pk_reports" PRIMARY KEY ("id"),
        CONSTRAINT "uq_reports_kind_period" UNIQUE ("kind", "period_start"),
        CONSTRAINT "chk_reports_kind" CHECK ("kind" IN ('daily', 'weekly')),
        CONSTRAINT "chk_reports_period" CHECK ("period_end" >= "period_start"),
        CONSTRAINT "chk_reports_text_len" CHECK (char_length("text_html") <= 16384)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_reports_period" ON "reports" ("period_start" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reports"`);
    await queryRunner.query(`DROP TABLE "watchdog_alerts"`);
  }
}
