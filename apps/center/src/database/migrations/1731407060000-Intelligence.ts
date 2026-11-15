import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aqlli yordamchi (6.1-6.3).
 *
 * - `session_summaries`: sessiya xulosasi (agentd lokal yaratadi, transcript markazga kelmaydi). Bir sessiyaga bitta (oxirgisi
 *   ustun: `ended` xulosasi `idle` ni almashtiradi). `search_text` = xulosa + done + open_items + files (ilova yig'adi, redakt
 *   qilingan); `search` = unga `simple` konfiguratsiyali GENERATED tsvector (GIN); `pg_trgm` bo'lsa `search_text` ga trigram GIN
 *   (qo'shimcha, bo'lmasa `ILIKE` ketma-ket skan: hajm kichik).
 * - `summary_runs`: kunlik xulosa ishga tushirishlari (Asia/Tashkent kuni) va ularning tokenlari: kunlik chegara uchun.
 * - `project_decisions`: loyiha/repo qarorlar jurnali (`base_key` = repo_key yoki `project:<uuid>`: bir repo barcha mashinalarda
 *   bitta jurnal). `proposed` = xulosa taklif qilgan, egasi qabul qilishi kerak.
 * - `decision_injections`: har sessiyaga qarorlar BIR marta kontekstga tushiriladi (birinchi prompt).
 * - `assistant_queries`: "Commander'dan savol" auditi. Savol matni REDAKT qilingan holda 30 kun saqlanadi (egasining o'z savoli);
 *   javob matni saqlanmaydi (faqat uzunlik).
 * - `commands.type` CHECK ga `assistant.ask` qo'shiladi (hozirgi ro'yxat o'qiladi: parallel migratsiyalar bilan to'qnashmaydi).
 */
const TYPE = 'assistant.ask';

async function currentTypes(q: QueryRunner): Promise<string[]> {
  const rows: Array<{ def: string }> = await q.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`);
  if (!rows[0]) throw new Error('chk_commands_type not found');
  return [...rows[0].def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] as string);
}

async function setTypes(q: QueryRunner, types: string[]): Promise<void> {
  await q.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
  await q.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK ("type" IN (${types.map((t) => `'${t}'`).join(', ')}))`);
}

export class Intelligence1731407060000 implements MigrationInterface {
  name = 'Intelligence1731407060000';

  public async up(q: QueryRunner): Promise<void> {
    const types = await currentTypes(q);
    if (!types.includes(TYPE)) await setTypes(q, [...types, TYPE]);

    await q.query(`
      CREATE TABLE "session_summaries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "session_id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "project_id" uuid,
        "task_key" text,
        "summary" text NOT NULL,
        "done" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "files" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "open_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "model" text NOT NULL,
        "tokens_used" integer NOT NULL DEFAULT 0,
        "prompt_count" integer NOT NULL DEFAULT 0,
        "source_tokens" bigint NOT NULL DEFAULT 0,
        "trigger" text NOT NULL,
        "search_text" text NOT NULL,
        "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "search_text")) STORED,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_session_summaries" PRIMARY KEY ("id"),
        CONSTRAINT "uq_session_summaries_session" UNIQUE ("session_id"),
        CONSTRAINT "fk_session_summaries_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_session_summaries_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_session_summaries_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_session_summaries_trigger" CHECK ("trigger" IN ('ended', 'idle'))
      )
    `);
    await q.query(`CREATE INDEX "idx_session_summaries_search" ON "session_summaries" USING gin ("search")`);
    await q.query(`CREATE INDEX "idx_session_summaries_project" ON "session_summaries" ("project_id", "updated_at" DESC)`);
    await q.query(`CREATE INDEX "idx_session_summaries_updated" ON "session_summaries" ("updated_at" DESC)`);
    // pg_trgm ixtiyoriy: bo'lmasa (yoki ruxsat yo'q) migratsiya to'xtamaydi
    await q.query(`
      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX "idx_session_summaries_trgm" ON "session_summaries" USING gin ("search_text" gin_trgm_ops);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm unavailable (%): trigram index skipped', SQLERRM;
      END $$
    `);

    await q.query(`
      CREATE TABLE "summary_runs" (
        "day" date NOT NULL,
        "runs" integer NOT NULL DEFAULT 0,
        "tokens" bigint NOT NULL DEFAULT 0,
        CONSTRAINT "pk_summary_runs" PRIMARY KEY ("day")
      )
    `);

    await q.query(`
      CREATE TABLE "project_decisions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "base_key" text NOT NULL,
        "project_id" uuid,
        "title" text NOT NULL,
        "decision" text NOT NULL,
        "reason" text NOT NULL,
        "alternatives" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" text NOT NULL DEFAULT 'active',
        "source" text NOT NULL,
        "source_session_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_decisions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_project_decisions_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_project_decisions_session" FOREIGN KEY ("source_session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_project_decisions_status" CHECK ("status" IN ('active', 'archived', 'proposed')),
        CONSTRAINT "chk_project_decisions_source" CHECK ("source" IN ('session', 'owner', 'summary'))
      )
    `);
    await q.query(`CREATE INDEX "idx_project_decisions_key" ON "project_decisions" ("base_key", "status", "created_at" DESC)`);

    await q.query(`
      CREATE TABLE "decision_injections" (
        "session_id" uuid NOT NULL,
        "injected_at" timestamptz NOT NULL DEFAULT now(),
        "decision_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "pk_decision_injections" PRIMARY KEY ("session_id"),
        CONSTRAINT "fk_decision_injections_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE
      )
    `);

    await q.query(`
      CREATE TABLE "assistant_queries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "device_id" uuid,
        "actor_kind" text NOT NULL,
        "channel" text NOT NULL,
        "question_redacted" text NOT NULL,
        "question_sha256" text NOT NULL,
        "question_chars" integer NOT NULL,
        "context_chars" integer NOT NULL DEFAULT 0,
        "status" text NOT NULL DEFAULT 'pending',
        "error_code" text,
        "answer_chars" integer,
        "command_id" uuid,
        "machine_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz,
        CONSTRAINT "pk_assistant_queries" PRIMARY KEY ("id"),
        CONSTRAINT "chk_assistant_queries_status" CHECK ("status" IN ('pending', 'done', 'failed')),
        CONSTRAINT "chk_assistant_queries_channel" CHECK ("channel" IN ('dashboard', 'telegram'))
      )
    `);
    await q.query(`CREATE INDEX "idx_assistant_queries_created" ON "assistant_queries" ("created_at" DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "assistant_queries"`);
    await q.query(`DROP TABLE "decision_injections"`);
    await q.query(`DROP TABLE "project_decisions"`);
    await q.query(`DROP TABLE "summary_runs"`);
    await q.query(`DROP TABLE "session_summaries"`);
    await q.query(`DELETE FROM "commands" WHERE "type" = '${TYPE}'`);
    const types = (await currentTypes(q)).filter((t) => t !== TYPE);
    await setTypes(q, types);
  }
}
