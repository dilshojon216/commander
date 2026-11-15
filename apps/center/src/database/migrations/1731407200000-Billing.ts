import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.7 Timesheet va 6.8 mijoz hisoboti.
 *
 * - `clients`: mijoz (nom, izoh, ixtiyoriy soatlik stavka + valyuta). Nom katta-kichik harfsiz UNIQUE.
 * - `client_projects`: loyiha guruhi (`project_key` = `COALESCE(repo_key, project_id::text)`, mashinalar bo'ylab) -> mijoz.
 *   Bitta loyiha guruhi faqat bitta mijozga tegishli (PK = project_key); bir mijozda ko'p loyiha.
 * - `client_report_snapshots`: yaratilgan mijoz hisobotlari jurnali (kim/qachon/qaysi ko'lam/xesh). Append-only:
 *   DELETE/TRUNCATE bloklangan, UPDATE faqat `telegram_sent_at` ni o'zgartira oladi. Fayl mazmuni SAQLANMAYDI (faqat xesh).
 */
export class Billing1731407200000 implements MigrationInterface {
  name = 'Billing1731407200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "clients" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "notes" text NOT NULL DEFAULT '',
        "hourly_rate" numeric(16,4),
        "currency" text NOT NULL DEFAULT 'UZS',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_clients" PRIMARY KEY ("id"),
        CONSTRAINT "chk_clients_name" CHECK (char_length("name") BETWEEN 1 AND 120),
        CONSTRAINT "chk_clients_notes" CHECK (char_length("notes") <= 2000),
        CONSTRAINT "chk_clients_currency" CHECK ("currency" IN ('UZS', 'USD')),
        CONSTRAINT "chk_clients_rate" CHECK ("hourly_rate" IS NULL OR "hourly_rate" >= 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_clients_name" ON "clients" (lower("name"))`);

    await queryRunner.query(`
      CREATE TABLE "client_projects" (
        "project_key" text NOT NULL,
        "client_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_client_projects" PRIMARY KEY ("project_key"),
        CONSTRAINT "fk_client_projects_client" FOREIGN KEY ("client_id") REFERENCES "clients" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_client_projects_key" CHECK (char_length("project_key") BETWEEN 1 AND 300)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_client_projects_client" ON "client_projects" ("client_id")`);

    await queryRunner.query(`
      CREATE TABLE "client_report_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "actor_device_id" uuid,
        "actor_kind" text NOT NULL,
        "client_id" uuid,
        "client_name" text NOT NULL,
        "project_keys" text[] NOT NULL,
        "period_from" date NOT NULL,
        "period_to" date NOT NULL,
        "show_hours" boolean NOT NULL DEFAULT false,
        "show_summary" boolean NOT NULL DEFAULT true,
        "html_sha256" text NOT NULL,
        "pdf_sha256" text NOT NULL,
        "html_bytes" integer NOT NULL,
        "pdf_bytes" integer NOT NULL,
        "telegram_sent_at" timestamptz,
        CONSTRAINT "pk_client_report_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "fk_client_report_snapshots_client" FOREIGN KEY ("client_id") REFERENCES "clients" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_client_report_snapshots_period" CHECK ("period_to" >= "period_from"),
        CONSTRAINT "chk_client_report_snapshots_sha" CHECK ("html_sha256" ~ '^[0-9a-f]{64}$' AND "pdf_sha256" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_client_report_snapshots_created" ON "client_report_snapshots" ("created_at" DESC)`);
    await queryRunner.query(`
      CREATE FUNCTION "client_report_snapshots_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'client_report_snapshots is append-only';
        END IF;
        IF (to_jsonb(NEW) - 'telegram_sent_at') IS DISTINCT FROM (to_jsonb(OLD) - 'telegram_sent_at') THEN
          RAISE EXCEPTION 'client_report_snapshots is append-only (only telegram_sent_at may change)';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_client_report_snapshots_guard" BEFORE UPDATE OR DELETE ON "client_report_snapshots"
        FOR EACH ROW EXECUTE FUNCTION "client_report_snapshots_guard"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_client_report_snapshots_truncate" BEFORE TRUNCATE ON "client_report_snapshots"
        FOR EACH STATEMENT EXECUTE FUNCTION "client_report_snapshots_guard"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_client_report_snapshots_truncate" ON "client_report_snapshots"`);
    await queryRunner.query(`DROP TRIGGER "trg_client_report_snapshots_guard" ON "client_report_snapshots"`);
    await queryRunner.query(`DROP FUNCTION "client_report_snapshots_guard"()`);
    await queryRunner.query(`DROP TABLE "client_report_snapshots"`);
    await queryRunner.query(`DROP TABLE "client_projects"`);
    await queryRunner.query(`DROP TABLE "clients"`);
  }
}
