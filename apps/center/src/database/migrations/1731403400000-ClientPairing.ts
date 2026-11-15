import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Klient pairing (4.x): menu-bar va mobil ilovalar uchun bir martalik kod -> klient tokeni.
 * Kod o'zi saqlanmaydi (faqat SHA-256), `scopes` kod yaratilganda belgilanadi (`admin` HECH QACHON).
 * `devices.platform`: pairing paytida klient bildirgan platforma (`macos`, `ios`, `android`).
 */
export class ClientPairing1731403400000 implements MigrationInterface {
  name = 'ClientPairing1731403400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN "platform" text`);
    await queryRunner.query(`
      CREATE TABLE "client_pairing_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code_hash" text NOT NULL,
        "kind" text NOT NULL,
        "name" text NOT NULL,
        "scopes" text[] NOT NULL,
        "token_days" integer NOT NULL DEFAULT 90,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz,
        "used_by_device_id" uuid,
        CONSTRAINT "pk_client_pairing_codes" PRIMARY KEY ("id"),
        CONSTRAINT "uq_client_pairing_codes_hash" UNIQUE ("code_hash"),
        CONSTRAINT "chk_client_pairing_codes_kind" CHECK ("kind" IN ('menubar', 'mobile')),
        CONSTRAINT "chk_client_pairing_codes_scopes" CHECK (cardinality("scopes") > 0 AND "scopes" <@ ARRAY['read', 'approve', 'control']::text[]),
        CONSTRAINT "chk_client_pairing_codes_days" CHECK ("token_days" BETWEEN 1 AND 3650),
        CONSTRAINT "fk_client_pairing_codes_device" FOREIGN KEY ("used_by_device_id") REFERENCES "devices" ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "client_pairing_codes"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "platform"`);
  }
}
