import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ko'p sessiyali orkestratsiya (3.9).
 *
 * - `orchestrations`: maqsad + workspace guruhi + bosh (lead) sessiya. `confirmation`/`confirmed_at`: egasi tasdig'i (istisno qurilma,
 *   Telegram inline yoki lead'ning birinchi `session.start` buyrug'iga berilgan Telegram step-up); shundan keyin shu orkestratsiya
 *   ichidagi dispatch'lar qayta step-up so'ramaydi (bir marta). `token_budget`: kirish+chiqish+kesh yozish tokenlari (kesh o'qish KIRMAYDI).
 * - `orchestration_steps`: reja qadamlari (`depends_on` = boshqa qadamlarning `key`lari; sikl servisda rad etiladi). `dispatch_seq`
 *   har dispatch'da oshadi (`Idempotency-Key = orch-<step>-<seq>`: ikki marta ishga tushmaydi).
 */
export class Orchestration1731403300000 implements MigrationInterface {
  name = 'Orchestration1731403300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "orchestrations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "goal" text NOT NULL,
        "group_key" text NOT NULL,
        "status" text NOT NULL DEFAULT 'planning',
        "origin" text NOT NULL,
        "task_key" text,
        "project_id" uuid,
        "lead_session_id" uuid,
        "lead_machine_id" uuid,
        "lead_command_id" uuid,
        "confirmation" text,
        "confirmed_at" timestamptz,
        "confirmed_by_device_id" uuid,
        "created_by_device_id" uuid,
        "token_budget" bigint NOT NULL,
        "max_concurrent" integer NOT NULL DEFAULT 3,
        "budget_exceeded_at" timestamptz,
        "cancel_reason" text,
        "notified_status" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "finished_at" timestamptz,
        CONSTRAINT "pk_orchestrations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_orch_project" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_orch_lead_session" FOREIGN KEY ("lead_session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_orch_lead_machine" FOREIGN KEY ("lead_machine_id") REFERENCES "machines" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_orch_confirmed_device" FOREIGN KEY ("confirmed_by_device_id") REFERENCES "devices" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_orch_created_device" FOREIGN KEY ("created_by_device_id") REFERENCES "devices" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_orch_status" CHECK ("status" IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
        CONSTRAINT "chk_orch_origin" CHECK ("origin" IN ('dashboard', 'telegram', 'lead')),
        CONSTRAINT "chk_orch_confirmation" CHECK ("confirmation" IS NULL OR "confirmation" IN ('exempt_device', 'telegram_inline', 'telegram_step_up')),
        CONSTRAINT "chk_orch_concurrent" CHECK ("max_concurrent" BETWEEN 1 AND 8),
        CONSTRAINT "chk_orch_budget" CHECK ("token_budget" > 0),
        CONSTRAINT "chk_orch_goal_len" CHECK (char_length("goal") <= 2100)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_orch_group" ON "orchestrations" ("group_key", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_orch_lead" ON "orchestrations" ("lead_session_id") WHERE "lead_session_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_orch_active" ON "orchestrations" ("updated_at") WHERE "status" IN ('planning', 'running', 'failed')`);

    await queryRunner.query(`
      CREATE TABLE "orchestration_steps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "orchestration_id" uuid NOT NULL,
        "key" text NOT NULL,
        "position" integer NOT NULL,
        "title" text NOT NULL,
        "role" text NOT NULL,
        "machine" text,
        "cwd" text,
        "depends_on" text[] NOT NULL DEFAULT '{}',
        "status" text NOT NULL DEFAULT 'pending',
        "assigned_session_id" uuid,
        "dispatch_mode" text,
        "dispatch_seq" integer NOT NULL DEFAULT 0,
        "dispatch_command_id" uuid,
        "queue_item_id" uuid,
        "result_summary" text,
        "last_error" text,
        "dispatched_at" timestamptz,
        "finished_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_orchestration_steps" PRIMARY KEY ("id"),
        CONSTRAINT "uq_orch_steps_key" UNIQUE ("orchestration_id", "key"),
        CONSTRAINT "uq_orch_steps_position" UNIQUE ("orchestration_id", "position"),
        CONSTRAINT "fk_orch_steps_orch" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_orch_steps_session" FOREIGN KEY ("assigned_session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_orch_steps_status" CHECK ("status" IN ('pending', 'dispatched', 'running', 'done', 'failed', 'cancelled')),
        CONSTRAINT "chk_orch_steps_mode" CHECK ("dispatch_mode" IS NULL OR "dispatch_mode" IN ('existing_session', 'new_session', 'queue')),
        CONSTRAINT "chk_orch_steps_position" CHECK ("position" >= 0 AND "position" < 20)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_orch_steps_session" ON "orchestration_steps" ("assigned_session_id") WHERE "assigned_session_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_orch_steps_command" ON "orchestration_steps" ("dispatch_command_id") WHERE "dispatch_command_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_orch_steps_open" ON "orchestration_steps" ("orchestration_id") WHERE "status" IN ('dispatched', 'running')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "orchestration_steps"`);
    await queryRunner.query(`DROP TABLE "orchestrations"`);
  }
}
