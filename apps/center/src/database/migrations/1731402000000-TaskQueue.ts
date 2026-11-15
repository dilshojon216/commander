import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vazifalar navbati (3.1).
 *
 * - `task_queue`: kechiktirilgan `session.start`. `prompt_enc` = AES-256-GCM (markaz kaliti sirlar volume'ida; DB'da ochiq matn YO'Q),
 *   `prompt_preview` = redakt qilingan <= 300 belgi (API faqat shuni ko'rsatadi). `confirmation` + `confirmed_at` + `creation_audit_id`:
 *   yaratish paytidagi step-up natijasi (istisno qurilma yoki Telegram inline); `queue.fired` auditi shunga havola qiladi.
 *   `fire_seq` har ishga tushirishda oshadi: `Idempotency-Key = queue-<id>-<seq>` (restartdan keyin ikki marta ochilmaydi).
 * - `task_queue_runs`: har ishga tushirish tarixi (takroriy elementlar uchun har chiqish = yangi sessiya).
 */
export class TaskQueue1731402000000 implements MigrationInterface {
  name = 'TaskQueue1731402000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "task_queue" (
        "id" uuid NOT NULL,
        "project_id" uuid,
        "machine_id" uuid NOT NULL,
        "cwd" text NOT NULL,
        "prompt_enc" bytea NOT NULL,
        "prompt_len" integer NOT NULL,
        "prompt_preview" text NOT NULL,
        "model" text,
        "permission_mode" text NOT NULL,
        "name" text,
        "task_key" text,
        "trigger" jsonb NOT NULL,
        "status" text NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "last_error_code" text,
        "created_by_device_id" uuid NOT NULL,
        "confirmation" text NOT NULL,
        "confirmed_at" timestamptz NOT NULL,
        "creation_audit_id" bigint,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "next_run_at" timestamptz,
        "fire_seq" integer NOT NULL DEFAULT 0,
        "last_session_id" uuid,
        "last_command_id" uuid,
        CONSTRAINT "pk_task_queue" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_queue_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_task_queue_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_task_queue_device" FOREIGN KEY ("created_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "fk_task_queue_session" FOREIGN KEY ("last_session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_task_queue_status" CHECK ("status" IN ('queued', 'waiting_trigger', 'starting', 'started', 'failed', 'cancelled')),
        CONSTRAINT "chk_task_queue_mode" CHECK ("permission_mode" IN ('default', 'acceptEdits', 'plan', 'auto')),
        CONSTRAINT "chk_task_queue_confirmation" CHECK ("confirmation" IN ('exempt_device', 'telegram_inline')),
        CONSTRAINT "chk_task_queue_preview_len" CHECK (char_length("prompt_preview") <= 301)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_task_queue_due" ON "task_queue" ("next_run_at") WHERE "status" IN ('queued', 'waiting_trigger', 'starting')`);
    await queryRunner.query(`CREATE INDEX "idx_task_queue_machine" ON "task_queue" ("machine_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_task_queue_project" ON "task_queue" ("project_id") WHERE "project_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "task_queue_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "queue_id" uuid NOT NULL,
        "fire_seq" integer NOT NULL,
        "fired_at" timestamptz NOT NULL DEFAULT now(),
        "status" text NOT NULL,
        "command_id" uuid,
        "session_id" uuid,
        "error_code" text,
        "finished_at" timestamptz,
        CONSTRAINT "pk_task_queue_runs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_task_queue_runs_seq" UNIQUE ("queue_id", "fire_seq"),
        CONSTRAINT "fk_task_queue_runs_queue" FOREIGN KEY ("queue_id") REFERENCES "task_queue" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_task_queue_runs_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_task_queue_runs_status" CHECK ("status" IN ('starting', 'started', 'failed', 'skipped'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_task_queue_runs_open" ON "task_queue_runs" ("fired_at") WHERE "status" = 'starting'`);
    await queryRunner.query(`CREATE INDEX "idx_task_queue_runs_queue" ON "task_queue_runs" ("queue_id", "fired_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "task_queue_runs"`);
    await queryRunner.query(`DROP TABLE "task_queue"`);
  }
}
