import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H-05: orkestratsiya tasdig'i qamrovi. Eski model: bitta tasdiq butun orkestratsiyani (istalgan mashina/cwd/rejim) qoplardi.
 * Yangi: tasdiq payti egasi ko'rgan qamrov (`scope`: mashinalar, aniq loyiha papkalari, ruxsat etilgan rejimlar, yangi sessiyalar
 * soni) saqlanadi va faqat shu doirada dispatch tasdiqsiz o'tadi. `scope IS NULL` (eski/lead yaratgan) = hech narsa qoplanmaydi.
 * `new_sessions_used`: qamrov ichida ochilgan yangi sessiya/navbat soni. `confirmed_targets`: `existing_session` dispatch uchun
 * egasi bir marta tasdiqlagan nishon sessiyalar (har bir nishon uchun birinchi marta Telegram tasdig'i).
 */
export class OrchestrationScope1731405000000 implements MigrationInterface {
  name = 'OrchestrationScope1731405000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orchestrations" ADD COLUMN "scope" jsonb`);
    await queryRunner.query(`ALTER TABLE "orchestrations" ADD COLUMN "new_sessions_used" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "orchestrations" ADD COLUMN "confirmed_targets" uuid[] NOT NULL DEFAULT '{}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orchestrations" DROP COLUMN "confirmed_targets"`);
    await queryRunner.query(`ALTER TABLE "orchestrations" DROP COLUMN "new_sessions_used"`);
    await queryRunner.query(`ALTER TABLE "orchestrations" DROP COLUMN "scope"`);
  }
}
