import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Markaz o'z-o'zini kuzatishi (5.5): `center_incidents`. `health_incidents` mashinaga bog'langan (machine_id NOT NULL FK,
 * kind CHECK), markazning o'zi mashina emas, shu sabab alohida jadval; holat mashinasi va xabar uslubi bir xil
 * (ochilish = DB + Telegram BIR marta, jiddiylashish = qayta xabar, tiklanish = "Tiklandi").
 */
export class CenterIncidents1731404020000 implements MigrationInterface {
  name = 'CenterIncidents1731404020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "center_incidents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" text NOT NULL,
        "severity" text NOT NULL,
        "summary" text NOT NULL,
        "opened_at" timestamptz NOT NULL DEFAULT now(),
        "resolved_at" timestamptz,
        "notified_at" timestamptz,
        CONSTRAINT "pk_center_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "chk_center_incidents_kind" CHECK ("kind" IN ('db_disk', 'backup', 'dashboard', 'tailscale', 'runtime', 'telegram')),
        CONSTRAINT "chk_center_incidents_severity" CHECK ("severity" IN ('warn', 'critical'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_center_incidents_open" ON "center_incidents" ("kind") WHERE "resolved_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_center_incidents_opened" ON "center_incidents" ("opened_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "center_incidents"`);
  }
}
