import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AskUserQuestion javoblari (6.13): `approvals.kind` ga 'question' qo'shiladi; `questions` (redakt qilingan strukturali
 * savollar) va `answers` (berilgan javoblar: variant indekslari + redakt qilingan erkin matn) jsonb ustunlari.
 * `approvals` oddiy jadval (hypertable emas). Hajm CHECK bilan cheklanadi (savollar <= 40 KB, javoblar <= 8 KB).
 * Retention: savol matnlari foydalanuvchi ma'lumoti, reja matni kabi 30 kundan keyin NULL qilinadi (servis soatlik tozalaydi).
 */
export class AskQuestions1731408300000 implements MigrationInterface {
  name = 'AskQuestions1731408300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_kind"`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_kind" CHECK ("kind" IN ('tool', 'plan', 'question'))`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "questions" jsonb`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "answers" jsonb`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_questions_size" CHECK ("questions" IS NULL OR (jsonb_typeof("questions") = 'array' AND octet_length("questions"::text) <= 40000))`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_answers_size" CHECK ("answers" IS NULL OR (jsonb_typeof("answers") = 'array' AND octet_length("answers"::text) <= 8000))`);
    await queryRunner.query(`CREATE INDEX "idx_approvals_questions_retention" ON "approvals" ("requested_at") WHERE "questions" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_approvals_questions_retention"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_answers_size"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_questions_size"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "answers"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "questions"`);
    await queryRunner.query(`DELETE FROM "approvals" WHERE "kind" = 'question'`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP CONSTRAINT "chk_approvals_kind"`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_kind" CHECK ("kind" IN ('tool', 'plan'))`);
  }
}
