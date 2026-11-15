import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.16 Loyihani arxivlash: `projects.archived_at` (NULL = faol).
 *
 * Arxiv = ro'yxatlardan yashirish. Hech narsa o'chirilmaydi: sessiyalar, token_usage va boshqa tarix joyida qoladi,
 * jami hisoblar (kunlik cagg'lar) o'zgarmaydi. Arxivlangan loyihada YANGI sessiya boshlansa `archived_at` tozalanadi
 * (haqiqiy ish qaytib ko'rinsin; events.service).
 * Qisman indeks: arxivlanganlar kam, "Arxivlanganlar" ro'yxati va faol filtr uchun.
 */
export class ProjectArchive1731408800000 implements MigrationInterface {
  name = 'ProjectArchive1731408800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "archived_at" timestamptz`);
    await queryRunner.query(`CREATE INDEX "idx_projects_archived" ON "projects" ("archived_at") WHERE "archived_at" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_projects_archived"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "archived_at"`);
  }
}
