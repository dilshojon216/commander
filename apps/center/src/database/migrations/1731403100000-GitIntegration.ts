import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Git/PR integratsiyasi (3.5).
 *
 *  - `commands`: yangi turlar `project.diff`, `project.open_pr`, `project.ci_status` (mavjud ro'yxatga qo'shiladi: boshqa migratsiyalar
 *    qo'shgan turlarga tegilmaydi; `down` faqat o'zinikini olib tashlaydi).
 *  - `sessions.start_head_sha`: `SessionStart`da agentd yuborgan git HEAD (sessiya diff'i bazasi). Faqat sha.
 *  - `project_prs`: Commander orqali ochilgan PR'lar (URL/raqam; sarlavha redakt qilingan). (project, number) noyob.
 *  - `project_ci_status`: har (loyiha, branch) uchun OXIRGI CI holati (gh), `failed_notified_run_id` = Telegram ogohlantirishi
 *    yuborilgan oxirgi run (bir run uchun bir marta).
 *  - `task_commits`: snapshot commitlaridan vazifaga bog'langan commitlar (`subject` = #task:/[id], `branch` = taxmin).
 */
const NEW_TYPES = ['project.diff', 'project.open_pr', 'project.ci_status'];

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

export class GitIntegration1731403100000 implements MigrationInterface {
  name = 'GitIntegration1731403100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);

    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "start_head_sha" text`);
    await queryRunner.query(`ALTER TABLE "sessions" ADD CONSTRAINT "chk_sessions_start_head_sha" CHECK ("start_head_sha" IS NULL OR "start_head_sha" ~ '^[0-9a-f]{7,64}$')`);

    await queryRunner.query(`
      CREATE TABLE "project_prs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "number" integer NOT NULL,
        "url" text NOT NULL,
        "title" text NOT NULL DEFAULT '',
        "branch" text NOT NULL,
        "base" text NOT NULL,
        "draft" boolean NOT NULL DEFAULT false,
        "state" text NOT NULL DEFAULT 'open',
        "opened_via" text NOT NULL DEFAULT 'dashboard',
        "opened_by_device_id" uuid,
        "command_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_prs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_project_prs_number" UNIQUE ("project_id", "number"),
        CONSTRAINT "fk_project_prs_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_project_prs_state" CHECK ("state" IN ('open', 'closed', 'merged')),
        CONSTRAINT "chk_project_prs_url" CHECK ("url" ~ '^https://')
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_project_prs_open" ON "project_prs" ("project_id", "created_at" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "project_ci_status" (
        "project_id" uuid NOT NULL,
        "branch" text NOT NULL,
        "state" text NOT NULL,
        "pr_number" integer,
        "pr_url" text,
        "checks" jsonb NOT NULL DEFAULT '[]',
        "run" jsonb,
        "run_id" text,
        "failed_notified_run_id" text,
        "checked_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_ci_status" PRIMARY KEY ("project_id", "branch"),
        CONSTRAINT "fk_project_ci_status_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_project_ci_status_state" CHECK ("state" IN ('success', 'failure', 'pending', 'none', 'unknown'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "task_commits" (
        "project_id" uuid NOT NULL,
        "sha" text NOT NULL,
        "task_key" text NOT NULL,
        "source" text NOT NULL,
        "subject" text NOT NULL DEFAULT '',
        "author" text NOT NULL DEFAULT '',
        "committed_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_commits" PRIMARY KEY ("project_id", "sha", "task_key"),
        CONSTRAINT "fk_task_commits_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_task_commits_source" CHECK ("source" IN ('subject', 'branch'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_task_commits_task" ON "task_commits" ("project_id", "task_key", "committed_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "task_commits"`);
    await queryRunner.query(`DROP TABLE "project_ci_status"`);
    await queryRunner.query(`DROP TABLE "project_prs"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "chk_sessions_start_head_sha"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "start_head_sha"`);
    const inList = NEW_TYPES.map((t) => `'${t}'`).join(', ');
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" IN (${inList})`);
    await setTypes(queryRunner, typesOf(await typeCheckDef(queryRunner)).filter((t) => !NEW_TYPES.includes(t)));
  }
}
