import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.18 Kunlik AI xulosa qism bo'yicha: `daily_summaries.part` ('' = butun loyiha / ildiz, hozirgidek; aks holda qism yo'li).
 *
 * Kalit (project_id, day) -> (project_id, day, part): mavjud qatorlar `part = ''` bilan o'zgarishsiz qoladi (orqaga mos).
 * `part` NOT NULL DEFAULT '' (NULL emas: PK ustuni va upsert kaliti sodda bo'lsin).
 * down: qism qatorlari o'chiriladi (ular eski sxemada saqlanmaydi), keyin eski PK qaytariladi.
 */
export class DailySummaryPart1731409000000 implements MigrationInterface {
  name = 'DailySummaryPart1731409000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "daily_summaries" ADD COLUMN "part" text NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" DROP CONSTRAINT "pk_daily_summaries"`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" ADD CONSTRAINT "pk_daily_summaries" PRIMARY KEY ("project_id", "day", "part")`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" ADD CONSTRAINT "chk_daily_summaries_part_len" CHECK (char_length("part") <= 300)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "daily_summaries" WHERE "part" <> ''`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" DROP CONSTRAINT "chk_daily_summaries_part_len"`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" DROP CONSTRAINT "pk_daily_summaries"`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" ADD CONSTRAINT "pk_daily_summaries" PRIMARY KEY ("project_id", "day")`);
    await queryRunner.query(`ALTER TABLE "daily_summaries" DROP COLUMN "part"`);
  }
}
