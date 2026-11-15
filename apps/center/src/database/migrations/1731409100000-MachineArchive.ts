import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N2.14 Mashinani arxivlash: `machines.archived_at` (NULL = faol). Loyiha arxivi (6.16, 1731408800000) bilan bir xil naqsh.
 *
 * Arxiv = standart ro'yxatdan yashirish (`GET /v1/machines`, Telegram). Hech narsa o'chirilmaydi: sessiyalar, token_usage,
 * qurilmalar va tarix joyida; `?archived=1` bilan ko'rinadi, `unarchive` qaytaradi. Qisman indeks: arxivlanganlar kam.
 * Qurilmani revoke qilish ALOHIDA amal (CLI `device revoke`): arxiv agentd ulanishiga ta'sir qilmaydi.
 */
export class MachineArchive1731409100000 implements MigrationInterface {
  name = 'MachineArchive1731409100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "machines" ADD COLUMN "archived_at" timestamptz`);
    await queryRunner.query(`CREATE INDEX "idx_machines_archived" ON "machines" ("archived_at") WHERE "archived_at" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_machines_archived"`);
    await queryRunner.query(`ALTER TABLE "machines" DROP COLUMN "archived_at"`);
  }
}
