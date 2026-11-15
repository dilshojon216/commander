import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.10 Haftalik xavfsizlik/dependency tekshiruvi + 6.11 kunlik byudjetlar.
 *
 *  - `commands`: yangi tur `project.scan` (mavjud ro'yxatga QO'SHILADI: boshqa migratsiyalar qo'shgan turlarga tegilmaydi;
 *    `down` faqat o'zinikini olib tashlaydi).
 *  - `project_scans`: loyiha skanlari (normallashtirilgan jiddiylik hisoblari + eng muhim topilmalar). Sir QIYMATI hech qachon:
 *    faqat fayl + qator + qoida nomi; matnlar markazda redakt qilingan. Loyiha bo'yicha oxirgi N ta saqlanadi (servis tozalaydi).
 *  - `budgets`: kunlik vaznli-token chegarasi, `(scope_kind, scope_key)`: `project` = project_key (repo_key yoki project uuid),
 *    `machine` = mashina uuid. `auto_stop` = qattiq chegarada ishlayotgan sessiyalarni avtomatik to'xtatish (default o'chiq).
 *  - `budget_overrides`: "bugun uchun +X" (kun bo'yicha; yarim kechada o'z-o'zidan amal qilmay qoladi).
 *  - `budget_alerts`: bir kunda bir daraja uchun bitta ogohlantirish (qayta yuborilmasin).
 */
const NEW_TYPES = ['project.scan'];

async function typeCheckDef(q: QueryRunner): Promise<string> {
  const rows: Array<{ def: string }> = await q.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`,
  );
  const def = rows[0]?.def;
  if (!def) throw new Error('chk_commands_type not found');
  return def;
}

const typesOf = (def: string): string[] => [...def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] as string);

async function setTypes(q: QueryRunner, types: string[]): Promise<void> {
  const list = types.map((t) => `'${t}'`).join(', ');
  await q.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
  await q.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK ("type" IN (${list}))`);
}

export class ScansBudgets1731408100000 implements MigrationInterface {
  name = 'ScansBudgets1731408100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);

    await queryRunner.query(`
      CREATE TABLE "project_scans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "command_id" uuid,
        "scanned_at" timestamptz NOT NULL DEFAULT now(),
        "counts" jsonb NOT NULL,
        "vuln_count" integer NOT NULL DEFAULT 0,
        "outdated_count" integer NOT NULL DEFAULT 0,
        "secret_count" integer NOT NULL DEFAULT 0,
        "env_file_count" integer NOT NULL DEFAULT 0,
        "ecosystems" text[] NOT NULL DEFAULT '{}',
        "tools" jsonb NOT NULL DEFAULT '[]',
        "findings" jsonb NOT NULL DEFAULT '[]',
        "findings_total" integer NOT NULL DEFAULT 0,
        "truncated" boolean NOT NULL DEFAULT false,
        "files_scanned" integer NOT NULL DEFAULT 0,
        "duration_ms" integer NOT NULL DEFAULT 0,
        "partial" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_project_scans" PRIMARY KEY ("id"),
        CONSTRAINT "fk_project_scans_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_project_scans_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_project_scans_command" FOREIGN KEY ("command_id") REFERENCES "commands" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_project_scans_project" ON "project_scans" ("project_id", "scanned_at" DESC)`);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_project_scans_command" ON "project_scans" ("command_id") WHERE "command_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "budgets" (
        "scope_kind" text NOT NULL,
        "scope_key" text NOT NULL,
        "daily_tokens" bigint NOT NULL,
        "auto_stop" boolean NOT NULL DEFAULT false,
        "updated_by_device_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_budgets" PRIMARY KEY ("scope_kind", "scope_key"),
        CONSTRAINT "chk_budgets_kind" CHECK ("scope_kind" IN ('project', 'machine')),
        CONSTRAINT "chk_budgets_key" CHECK (char_length("scope_key") BETWEEN 1 AND 300),
        CONSTRAINT "chk_budgets_tokens" CHECK ("daily_tokens" >= 10000)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "budget_overrides" (
        "scope_kind" text NOT NULL,
        "scope_key" text NOT NULL,
        "day" date NOT NULL,
        "extra_tokens" bigint NOT NULL,
        "set_by_device_id" uuid,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_budget_overrides" PRIMARY KEY ("scope_kind", "scope_key", "day"),
        CONSTRAINT "chk_budget_overrides_kind" CHECK ("scope_kind" IN ('project', 'machine')),
        CONSTRAINT "chk_budget_overrides_extra" CHECK ("extra_tokens" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "budget_alerts" (
        "scope_kind" text NOT NULL,
        "scope_key" text NOT NULL,
        "day" date NOT NULL,
        "level" text NOT NULL,
        "notified_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_budget_alerts" PRIMARY KEY ("scope_kind", "scope_key", "day", "level"),
        CONSTRAINT "chk_budget_alerts_level" CHECK ("level" IN ('soft', 'hard'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "budget_alerts"`);
    await queryRunner.query(`DROP TABLE "budget_overrides"`);
    await queryRunner.query(`DROP TABLE "budgets"`);
    await queryRunner.query(`DROP TABLE "project_scans"`);
    // Yangi tur bilan yozilgan buyruqlar bo'lsa ro'yxatni toraytirib bo'lmaydi (CHECK buzilardi): ularni o'chiramiz (topilmalar baribir commands'da emas).
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = ANY($1)`, [NEW_TYPES]);
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, types.filter((t) => !NEW_TYPES.includes(t)));
  }
}
