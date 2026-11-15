import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.12 Haftalik limit tezligi (kunlik ulush).
 *
 *  - `pace_alerts`: bir Toshkent kunida bir daraja (`soft` = ulushning 80%, `hard` = 100%) uchun bitta ogohlantirish
 *    (qayta yuborilmasin). Kun boshidagi foiz DB'da saqlanmaydi: `limit_samples` dan deterministik qayta hisoblanadi
 *    (`limits/pace-logic.ts`). Sozlamalar va "bugun uchun ruxsat" mavjud `settings` jadvalida (`limits.pace*` kalitlari).
 */
export class WeeklyPace1731408200000 implements MigrationInterface {
  name = 'WeeklyPace1731408200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pace_alerts" (
        "day" date NOT NULL,
        "level" text NOT NULL,
        "window_resets_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_pace_alerts" PRIMARY KEY ("day", "level"),
        CONSTRAINT "chk_pace_alerts_level" CHECK ("level" IN ('soft', 'hard'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pace_alerts"`);
  }
}
