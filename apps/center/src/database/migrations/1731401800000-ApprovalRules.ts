import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Avto-ruxsat qoidalari (2.13) va reja so'rovlari (2.14).
 *
 * - `approval_rules`: markaz siyosati. `scope`: session (scope_ref = sessions.id) | project (projects.id) |
 *   repo (projects.repo_key). `expires_at` MAJBURIY va yaratilgandan <= 7 kun (CHECK); `revoked_at` darhol kuchga kiradi.
 *   `tools` allow-list'i servis/Zod darajasida (Bash/shell/Task/Agent hech qachon); DB faqat hajmni cheklaydi.
 * - `approvals.auto_rule_id`: so'rovni qaysi qoida avto-ruxsat qilgani (qaror `system` aktyoridan, `decided_by_device_id` NULL).
 *   `chk_approvals_decided` yangilanadi: qaror = (qurilma YOKI qoida) + vaqt.
 * - `approvals.kind` ('tool'|'plan') va `plan_text` (redakt qilingan reja, <= 16384 belgi): foydalanuvchining o'z rejasi,
 *   retention 30 kun (servis davriy ravishda NULL qiladi; qator o'zi saqlanadi).
 */
export class ApprovalRules1731401800000 implements MigrationInterface {
  name = 'ApprovalRules1731401800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "approval_rules" (
        "id" bigint GENERATED ALWAYS AS IDENTITY,
        "scope" text NOT NULL,
        "scope_ref" text NOT NULL,
        "tools" text[] NOT NULL,
        "path_globs" text[] NOT NULL DEFAULT '{}',
        "expires_at" timestamptz NOT NULL,
        "created_by_device_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revoked_by_device_id" uuid,
        CONSTRAINT "pk_approval_rules" PRIMARY KEY ("id"),
        CONSTRAINT "fk_approval_rules_created_by" FOREIGN KEY ("created_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "fk_approval_rules_revoked_by" FOREIGN KEY ("revoked_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "chk_approval_rules_scope" CHECK ("scope" IN ('session', 'project', 'repo')),
        CONSTRAINT "chk_approval_rules_tools" CHECK (cardinality("tools") BETWEEN 1 AND 12),
        CONSTRAINT "chk_approval_rules_globs" CHECK (cardinality("path_globs") <= 10),
        CONSTRAINT "chk_approval_rules_expiry" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '7 days'),
        CONSTRAINT "chk_approval_rules_revoked" CHECK (("revoked_at" IS NULL) = ("revoked_by_device_id" IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_approval_rules_active" ON "approval_rules" ("scope", "scope_ref") WHERE "revoked_at" IS NULL`);

    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "kind" text NOT NULL DEFAULT 'tool'`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_kind" CHECK ("kind" IN ('tool', 'plan'))`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "plan_text" text`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_plan_len" CHECK ("plan_text" IS NULL OR char_length("plan_text") <= 16384)`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "auto_rule_id" bigint`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "fk_approvals_auto_rule" FOREIGN KEY ("auto_rule_id") REFERENCES "approval_rules" ("id")`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_decided"`);
    await queryRunner.query(`
      ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_decided" CHECK (
        ("status" IN ('approved', 'denied'))
          = ("decided_at" IS NOT NULL AND ("decided_by_device_id" IS NOT NULL OR "auto_rule_id" IS NOT NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_approvals_auto_rule" ON "approvals" ("auto_rule_id", "requested_at") WHERE "auto_rule_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_approvals_plan_retention" ON "approvals" ("requested_at") WHERE "plan_text" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_approvals_plan_retention"`);
    await queryRunner.query(`DROP INDEX "idx_approvals_auto_rule"`);
    // Qoida bilan hal qilingan qatorlar eski CHECK'ga mos emas: qurilmasi bo'lmaganlari o'chiriladi (audit_log saqlanadi).
    await queryRunner.query(`DELETE FROM "approvals" WHERE "auto_rule_id" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_decided"`);
    await queryRunner.query(`
      ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_decided" CHECK (
        ("status" IN ('approved', 'denied')) = ("decided_by_device_id" IS NOT NULL AND "decided_at" IS NOT NULL)
      )
    `);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "fk_approvals_auto_rule"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "auto_rule_id"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "plan_text"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "kind"`);
    await queryRunner.query(`DROP TABLE "approval_rules"`);
  }
}
