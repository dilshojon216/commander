import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TimescaleDB kengaytmasi. Bazani TimescaleDB image'dan boshlash shart
 * (timescale/timescaledb:*-pg16; shared_preload_libraries ichida timescaledb).
 * CREATE EXTENSION superuser (yoki trusted) huquqini talab qiladi: compose'dagi
 * POSTGRES_USER shunday.
 */
export class EnableTimescale1731400100000 implements MigrationInterface {
  name = 'EnableTimescale1731400100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Kengaytmani olib tashlamaymiz: boshqa hypertable'lar (yoki restore) unga
    // tayanishi mumkin; bu migratsiya faqat "mavjud bo'lsin" kafolatini beradi.
    void queryRunner;
  }
}
