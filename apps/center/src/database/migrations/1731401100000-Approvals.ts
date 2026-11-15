import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remote permission navbati (task 1.7, PLAN 6.4).
 *
 * - `id` = agentd yaratgan `approvalId` (uuid): qayta yuborish idempotent (`ON CONFLICT DO NOTHING`).
 * - `status`: pending -> approved | denied | expired | cancelled. Faqat `pending` dan o'tiladi
 *   (`UPDATE ... WHERE status='pending'`): birinchi qaror yutadi.
 * - `tool_input_redacted` <= 8192 belgi (CHECK): xom kiritma markazga KELMAYDI; `tool_input_full_hash` = sha256.
 * - Sessiyaga bog'lanish `(machine_id, claude_session_id)` orqali (join): hodisalar va approval boshqa outbox
 *   oqimlarida keladi, sessiya qatori approval'dan KEYIN paydo bo'lishi mumkin. `prev_session_status`: approval
 *   ochilganda sessiya holati (ma'lumot; tiklash `approved/denied/cancelled -> working`, `expired -> waiting` servisda).
 * - `delivered_at`: qaror agentd ulanishiga yuborilgan vaqt (NULL = yetkazilmagan: qayta ulanganda qayta yuboriladi).
 * - Retention yo'q (kam hajm; audit_log alohida zanjir). Tavsiya: 90 kundan keyin tozalash (Faza 4.2).
 */
export class Approvals1731401100000 implements MigrationInterface {
  name = 'Approvals1731401100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "approvals" (
        "id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "claude_session_id" text NOT NULL,
        "cwd" text NOT NULL,
        "tool_name" text NOT NULL,
        "tool_input_redacted" text NOT NULL,
        "tool_input_full_hash" text NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "decision_message" text,
        "decided_by_device_id" uuid,
        "decided_at" timestamptz,
        "delivered_at" timestamptz,
        "requested_at" timestamptz NOT NULL DEFAULT now(),
        "deadline" timestamptz NOT NULL,
        "resolved_at" timestamptz,
        "prev_session_status" text,
        CONSTRAINT "pk_approvals" PRIMARY KEY ("id"),
        CONSTRAINT "fk_approvals_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_approvals_decided_by" FOREIGN KEY ("decided_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "chk_approvals_status" CHECK ("status" IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
        CONSTRAINT "chk_approvals_input_len" CHECK (char_length("tool_input_redacted") <= 8192),
        CONSTRAINT "chk_approvals_hash" CHECK ("tool_input_full_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_approvals_resolved" CHECK (("status" = 'pending') = ("resolved_at" IS NULL)),
        CONSTRAINT "chk_approvals_decided" CHECK (
          ("status" IN ('approved', 'denied')) = ("decided_by_device_id" IS NOT NULL AND "decided_at" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_approvals_pending" ON "approvals" ("deadline") WHERE "status" = 'pending'`);
    await queryRunner.query(`CREATE INDEX "idx_approvals_requested" ON "approvals" ("requested_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_approvals_machine" ON "approvals" ("machine_id", "requested_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_approvals_session_pending" ON "approvals" ("machine_id", "claude_session_id") WHERE "status" = 'pending'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "approvals"`);
  }
}
