import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Loyiha ish maydoni (task 2.15).
 *
 *  - `commands`: yangi turlar (`project.refresh|read_md|append_tasks|summarize`) + `project_id`.
 *  - `project_snapshots`: `md_files` (loyihadagi *.md ro'yxati, <= 200 yo'l) va `tasks_hash` (TASKS.md xom baytlari sha256'i:
 *    `project.append_tasks` optimistik konkurentligi uchun).
 *  - `task_board`: doskadagi qo'lda surilgan ustun (overlay). Samarali ustun: TASKS.md `done` har doim ustun; aks holda overlay; aks holda hisoblangan.
 *  - `task_events`: vazifa holati o'zgarishlari jurnali (`tasks_md` = snapshot farqi, `board` = doskada surilgan): kunlik "yopilgan vazifalar" shundan.
 *  - `daily_summaries`: Claude'ning kun xulosasi va vazifa baholari (bir loyiha + kun = bitta qator, qayta yaratilsa almashtiriladi).
 */
export class ProjectWork1731401500000 implements MigrationInterface {
  name = 'ProjectWork1731401500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
    await queryRunner.query(`
      ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK (
        "type" IN ('session.start', 'session.prompt', 'session.interrupt', 'session.stop', 'session.set_mode', 'agent.reconfigure',
                   'project.refresh', 'project.read_md', 'project.append_tasks', 'project.summarize')
      )`);
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "project_id" uuid`);
    await queryRunner.query(`ALTER TABLE "commands" ADD CONSTRAINT "fk_commands_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL`);
    await queryRunner.query(`CREATE INDEX "idx_commands_project" ON "commands" ("project_id", "created_at" DESC) WHERE "project_id" IS NOT NULL`);

    await queryRunner.query(`ALTER TABLE "project_snapshots" ADD COLUMN "md_files" jsonb`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" ADD COLUMN "tasks_hash" text`);

    await queryRunner.query(`
      CREATE TABLE "task_board" (
        "project_id" uuid NOT NULL,
        "task_key" text NOT NULL,
        "board_column" text NOT NULL,
        "updated_by_device_id" uuid,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_board" PRIMARY KEY ("project_id", "task_key"),
        CONSTRAINT "fk_task_board_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_task_board_column" CHECK ("board_column" IN ('todo', 'doing', 'review', 'done'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "task_events" (
        "id" bigserial NOT NULL,
        "project_id" uuid NOT NULL,
        "task_key" text NOT NULL,
        "from_status" text,
        "to_status" text NOT NULL,
        "source" text NOT NULL,
        "device_id" uuid,
        "ts" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_events" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_events_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_task_events_source" CHECK ("source" IN ('tasks_md', 'board'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_task_events_project_ts" ON "task_events" ("project_id", "ts" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "daily_summaries" (
        "project_id" uuid NOT NULL,
        "day" date NOT NULL,
        "summary" text NOT NULL,
        "scores" jsonb NOT NULL DEFAULT '[]',
        "model" text NOT NULL,
        "command_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_daily_summaries" PRIMARY KEY ("project_id", "day"),
        CONSTRAINT "fk_daily_summaries_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "daily_summaries"`);
    await queryRunner.query(`DROP TABLE "task_events"`);
    await queryRunner.query(`DROP TABLE "task_board"`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" DROP COLUMN "tasks_hash"`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" DROP COLUMN "md_files"`);
    await queryRunner.query(`DROP INDEX "idx_commands_project"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "fk_commands_project"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "project_id"`);
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" LIKE 'project.%'`);
    await queryRunner.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
    await queryRunner.query(`
      ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK (
        "type" IN ('session.start', 'session.prompt', 'session.interrupt', 'session.stop', 'session.set_mode', 'agent.reconfigure')
      )`);
  }
}
