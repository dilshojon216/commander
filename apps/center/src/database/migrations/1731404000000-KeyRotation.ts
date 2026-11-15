import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kalit aylantirish va darhol uzish (5.1).
 *
 * - `devices.rotation_required`: markaz tashabbusi bilan "kalitni aylantiring" bayrog'i (CLI `device require-rotation`);
 *   agentd uni `auth.ok` va `key.rotation_required` orqali oladi, `key.rotate` muvaffaqiyatli bo'lsa o'chadi.
 * - `devices.key_rotated_at`: oxirgi aylantirish vaqti.
 * - Trigger `trg_devices_notify_revoked`: `revoked_at` NULL -> qiymat bo'lganda `pg_notify('commander_device_events',
 *   'revoked:<id>')`. Revoke QAYSI yo'ldan o'tsa ham (CLI jarayoni, o'zini revoke qilish, Telegram chat o'chirish, to'g'ridan
 *   SQL) center jarayoni LISTEN orqali shu zahoti mos WS ulanishini 4010 bilan yopadi. NOTIFY COMMIT'dan keyin yetkaziladi,
 *   shu sabab "revoke qaytarib olingan tranzaksiya" ulanishni uzmaydi. Sweep (5-15 s) zaxira sifatida qoladi.
 */
export class KeyRotation1731404000000 implements MigrationInterface {
  name = 'KeyRotation1731404000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN "rotation_required" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN "key_rotated_at" timestamptz`);
    await queryRunner.query(`
      CREATE FUNCTION devices_notify_revoked() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_notify('commander_device_events', 'revoked:' || NEW.id::text);
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_devices_notify_revoked
        AFTER UPDATE OF "revoked_at" ON "devices"
        FOR EACH ROW
        WHEN (OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL)
        EXECUTE FUNCTION devices_notify_revoked()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_devices_notify_revoked" ON "devices"`);
    await queryRunner.query(`DROP FUNCTION devices_notify_revoked()`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "key_rotated_at"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "rotation_required"`);
  }
}
