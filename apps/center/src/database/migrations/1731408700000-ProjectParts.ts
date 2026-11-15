import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.15 Loyiha qismlari (monorepo ichidagi papkalar, har birining o'z reja fayli).
 *
 *  - `project_parts`: loyiha qismlari (yo'l ildizga nisbatan), reja fayllari va agentd hisoblagan progress sanoqlari
 *    (bandlar ro'yxati hajm sababli qisqargan bo'lsa ham sanoq to'g'ri).
 *  - `project_tasks.part` ('' = ildiz, mavjud qatorlar shunday qoladi) va `done_on` (bajarilgan sana, fayl sarlavhasidan).
 *    Qism vazifalarining `task_key` i nomlar maydoni bilan yoziladi (`<slug>:<id>`), shuning uchun (project_id, task_key)
 *    unikal kaliti, `task_board`/`task_events`/`session_task_spans`/`task_commits` kalitlari O'ZGARMAYDI va qismlar orasida
 *    to'qnashmaydi (ildiz kaliti `:` tutmaydi).
 *  - `task_board.part`: qism (filtr uchun; overlay kaliti o'zgarmagan).
 *  - `sessions.start_cwd` (birinchi hodisadagi cwd, bir marta yoziladi; mavjud sessiyalar uchun joriy cwd taxmini) va
 *    `sessions.part` (NULL = hali aniqlanmagan/qismlar yo'q = ildiz; bir marta yoziladi). Qism = start_cwd prefiksi bo'lgan
 *    ENG UZUN qism yo'li (`project_parts` ma'lum bo'lgach).
 *
 * Giper-jadvallarga tegilmaydi (token_usage/session_events/machine_heartbeats): qism sessiyadan hosil qilinadi.
 */
export class ProjectParts1731408700000 implements MigrationInterface {
  name = 'ProjectParts1731408700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "project_parts" (
        "project_id" uuid NOT NULL,
        "part" text NOT NULL,
        "name" text NOT NULL,
        "plan_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "todo" integer NOT NULL DEFAULT 0,
        "doing" integer NOT NULL DEFAULT 0,
        "done" integer NOT NULL DEFAULT 0,
        "unknown" integer NOT NULL DEFAULT 0,
        "total" integer NOT NULL DEFAULT 0,
        "items_truncated" boolean NOT NULL DEFAULT false,
        "read_truncated" boolean NOT NULL DEFAULT false,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_parts" PRIMARY KEY ("project_id", "part"),
        CONSTRAINT "fk_project_parts_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_project_parts_part" CHECK ("part" <> '')
      )
    `);
    await queryRunner.query(`ALTER TABLE "project_tasks" ADD COLUMN "part" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "project_tasks" ADD COLUMN "done_on" date`);
    await queryRunner.query(`CREATE INDEX "idx_project_tasks_part" ON "project_tasks" ("project_id", "part")`);
    await queryRunner.query(`ALTER TABLE "task_board" ADD COLUMN "part" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "start_cwd" text`);
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "part" text`);
    await queryRunner.query(`UPDATE "sessions" SET "start_cwd" = "cwd" WHERE "start_cwd" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_sessions_part_pending" ON "sessions" ("project_id") WHERE "part" IS NULL AND "project_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_sessions_project_part" ON "sessions" ("project_id", "part") WHERE "part" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Qism vazifalari (nomlar maydonli kalit) o'chiriladi: ustun bo'lmasa ularni ildizdan ajratib bo'lmaydi
    await queryRunner.query(`DELETE FROM "task_events" WHERE position(':' in "task_key") > 0`);
    await queryRunner.query(`DELETE FROM "session_task_spans" WHERE position(':' in "task_key") > 0`);
    await queryRunner.query(`DELETE FROM "task_commits" WHERE position(':' in "task_key") > 0`);
    await queryRunner.query(`DELETE FROM "task_board" WHERE "part" <> ''`);
    await queryRunner.query(`DELETE FROM "project_tasks" WHERE "part" <> ''`);
    await queryRunner.query(`DROP INDEX "idx_sessions_project_part"`);
    await queryRunner.query(`DROP INDEX "idx_sessions_part_pending"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "part"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "start_cwd"`);
    await queryRunner.query(`ALTER TABLE "task_board" DROP COLUMN "part"`);
    await queryRunner.query(`DROP INDEX "idx_project_tasks_part"`);
    await queryRunner.query(`ALTER TABLE "project_tasks" DROP COLUMN "done_on"`);
    await queryRunner.query(`ALTER TABLE "project_tasks" DROP COLUMN "part"`);
    await queryRunner.query(`DROP TABLE "project_parts"`);
  }
}
