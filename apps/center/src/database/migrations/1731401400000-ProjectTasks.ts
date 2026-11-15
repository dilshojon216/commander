import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Loyiha rejasi va vazifa atributsiyasi (task 2.1, 2.2, 2.8, 2.9).
 *
 *  - `project_snapshots`: `head_sha`, `tasks_md` (+ `tasks_path`). Bir loyiha uchun faqat oxirgi ~10 snapshot saqlanadi
 *    (md matnlari faqat oxirgi 3 tasida: servis `ProjectSnapshotService` tozalaydi).
 *  - `project_tasks`: oxirgi snapshot'dagi TASKS.md jadvalidan server tomonda parse qilingan vazifalar (har snapshot'da almashtiriladi).
 *  - `session_task_spans`: sessiyaning vazifaga bog'langan vaqt oralig'i (`explicit` = /task yoki #task:, `branch` = git branch taxmini).
 *    Bir sessiyada bir vaqtda BITTA ochiq span (qisman UNIQUE indeks). `session_id` = Claude sessiya id'si (token_usage.session_id bilan
 *    bir xil): token_usage'ga to'g'ridan-to'g'ri `(machine_id, session_id, ts)` bo'yicha qo'shiladi.
 *  - `idx_token_usage_session_ts`: span oynasidagi usage qatorlarini indeks bilan topish (vazifa statistikasi).
 */
export class ProjectTasks1731401400000 implements MigrationInterface {
  name = 'ProjectTasks1731401400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_snapshots" ADD COLUMN "head_sha" text`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" ADD COLUMN "tasks_md" text`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" ADD COLUMN "tasks_path" text`);

    await queryRunner.query(`
      CREATE TABLE "project_tasks" (
        "project_id" uuid NOT NULL,
        "task_key" text NOT NULL,
        "title" text NOT NULL,
        "phase" text,
        "status" text NOT NULL,
        "raw_status" text,
        "order" integer NOT NULL,
        "size" text,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_tasks" PRIMARY KEY ("project_id", "task_key"),
        CONSTRAINT "fk_project_tasks_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_project_tasks_status" CHECK ("status" IN ('todo', 'doing', 'done', 'unknown'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_project_tasks_order" ON "project_tasks" ("project_id", "order")`);

    await queryRunner.query(`
      CREATE TABLE "session_task_spans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "machine_id" uuid NOT NULL,
        "session_id" text NOT NULL,
        "project_id" uuid,
        "task_key" text NOT NULL,
        "source" text NOT NULL,
        "started_at" timestamptz NOT NULL,
        "ended_at" timestamptz,
        CONSTRAINT "pk_session_task_spans" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_spans_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_task_spans_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id"),
        CONSTRAINT "chk_task_spans_source" CHECK ("source" IN ('explicit', 'branch')),
        CONSTRAINT "chk_task_spans_window" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
        CONSTRAINT "chk_task_spans_key_len" CHECK (char_length("task_key") <= 32)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_task_spans_open" ON "session_task_spans" ("machine_id", "session_id") WHERE "ended_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_task_spans_session" ON "session_task_spans" ("machine_id", "session_id", "started_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_task_spans_project_task" ON "session_task_spans" ("project_id", "task_key")`);

    await queryRunner.query(`CREATE INDEX "idx_token_usage_session_ts" ON "token_usage" ("machine_id", "session_id", "ts")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_token_usage_session_ts"`);
    await queryRunner.query(`DROP TABLE "session_task_spans"`);
    await queryRunner.query(`DROP TABLE "project_tasks"`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" DROP COLUMN "tasks_path"`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" DROP COLUMN "tasks_md"`);
    await queryRunner.query(`ALTER TABLE "project_snapshots" DROP COLUMN "head_sha"`);
  }
}
