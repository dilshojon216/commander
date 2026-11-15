import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sozlamalarni markazdan tarqatish (3.7).
 *
 * - `config_profiles`: profil VERSIYALARI (har capture = yangi qator; `(name, version)` noyob). `settings` = `settings.json` bo'lagi
 *   (sirsiz, tekshirilgan; faqat permissions.allow|deny va env). `skipped` = capture'da rad etilgan fayllar (yo'l + sabab, mazmunsiz).
 * - `config_profile_files`: versiyadagi fayllar (matn, sha256 bilan). Sirli fayl agentd tomonida rad etilgan va markazda qayta tekshiriladi.
 * - `config_machine_state`: mashinaning oxirgi drift hisoboti (heartbeat `config`) va hisoblangan holat (Telegram "o'tish" ogohlantirishi uchun).
 * Amallar (capture/diff/apply/rollback) `commands` + `audit_log` orqali (yangi jadval kerak emas); zaxiralar agentda saqlanadi
 * va hisobotda keladi.
 */
const NEW_TYPES = ['config.capture', 'config.apply', 'config.rollback'];

/** `chk_commands_type` ning HOZIRGI ro'yxatini o'qib, faqat o'z turlarimizni qo'shadi/olib tashlaydi (parallel migratsiyalar bilan to'qnashmaydi). */
async function currentTypes(q: QueryRunner): Promise<string[]> {
  const rows: Array<{ def: string }> = await q.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`);
  if (!rows[0]) throw new Error('chk_commands_type not found');
  return [...rows[0].def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] as string);
}

async function setTypes(q: QueryRunner, types: string[]): Promise<void> {
  await q.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
  await q.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK ("type" IN (${types.map((t) => `'${t}'`).join(', ')}))`);
}

export class ConfigSync1731403200000 implements MigrationInterface {
  name = 'ConfigSync1731403200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = await currentTypes(queryRunner);
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);
    await queryRunner.query(`
      CREATE TABLE "config_profiles" (
        "id" uuid NOT NULL,
        "name" text NOT NULL,
        "version" integer NOT NULL,
        "source_machine_id" uuid,
        "created_by_device_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "file_count" integer NOT NULL,
        "total_bytes" integer NOT NULL,
        "settings" jsonb,
        "settings_sha256" text,
        "skipped" jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "pk_config_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "uq_config_profiles_name_version" UNIQUE ("name", "version"),
        CONSTRAINT "fk_config_profiles_machine" FOREIGN KEY ("source_machine_id") REFERENCES "machines" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_config_profiles_version" CHECK ("version" >= 1)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "config_profile_files" (
        "profile_id" uuid NOT NULL,
        "path" text NOT NULL,
        "kind" text NOT NULL,
        "sha256" text NOT NULL,
        "size" integer NOT NULL,
        "exec" boolean NOT NULL DEFAULT false,
        "content" text NOT NULL,
        CONSTRAINT "pk_config_profile_files" PRIMARY KEY ("profile_id", "path"),
        CONSTRAINT "fk_config_profile_files_profile" FOREIGN KEY ("profile_id") REFERENCES "config_profiles" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_config_profile_files_kind" CHECK ("kind" IN ('claude_md', 'skill', 'agent', 'command'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "config_machine_state" (
        "machine_id" uuid NOT NULL,
        "report" jsonb NOT NULL,
        "reported_at" timestamptz NOT NULL DEFAULT now(),
        "status" text,
        CONSTRAINT "pk_config_machine_state" PRIMARY KEY ("machine_id"),
        CONSTRAINT "fk_config_machine_state_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" IN ('config.capture', 'config.apply', 'config.rollback')`);
    await setTypes(queryRunner, (await currentTypes(queryRunner)).filter((t) => !NEW_TYPES.includes(t)));
    await queryRunner.query(`DROP TABLE "config_machine_state"`);
    await queryRunner.query(`DROP TABLE "config_profile_files"`);
    await queryRunner.query(`DROP TABLE "config_profiles"`);
  }
}
