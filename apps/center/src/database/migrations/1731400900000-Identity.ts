import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 0.6 Identity.
 *
 * - `devices` klient tokenlari uchun ham ishlatiladi (kind web/menubar/mobile/telegram,
 *   `token_hash` = SHA-256, `scopes`): alohida `client_tokens` jadvali YO'Q, chunki
 *   `commands.requested_by_device_id` va `audit_log.actor_device_id` FK'lari `devices`ga
 *   qaraydi. Qo'shiladi: `expires_at` va `scopes` CHECK (faqat read|approve|control|admin).
 * - `enrollment_codes`: bir martalik, qisqa muddatli; kod faqat SHA-256 xeshi sifatida.
 * - `used_nonces`: imzolangan so'rovlar replay'iga qarshi (Postgres: restartdan omon qoladi).
 *   Qatorlar `expires_at` dan keyin ilova tomonidan tozalanadi.
 * - `settings`: kalit/qiymat (hozir faqat `lockdown`), CLI va API bir xil holatni ko'radi.
 * - `machine_merge_candidates`: legacy_unverified mashina bilan hostname mos kelganda
 *   yozuv qoldiriladi; AVTOMATIK BIRLASHTIRILMAYDI.
 */
export class Identity1731400900000 implements MigrationInterface {
  name = 'Identity1731400900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "devices" ADD COLUMN "expires_at" timestamptz`);
    await queryRunner.query(`
      ALTER TABLE "devices" ADD CONSTRAINT "chk_devices_scopes"
        CHECK ("scopes" <@ ARRAY['read', 'approve', 'control', 'admin']::text[])
    `);

    await queryRunner.query(`
      CREATE TABLE "enrollment_codes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code_hash" text NOT NULL,
        "kind" text NOT NULL,
        "machine_name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz,
        "used_by_device_id" uuid,
        CONSTRAINT "pk_enrollment_codes" PRIMARY KEY ("id"),
        CONSTRAINT "uq_enrollment_codes_hash" UNIQUE ("code_hash"),
        CONSTRAINT "fk_enrollment_codes_device" FOREIGN KEY ("used_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "chk_enrollment_codes_kind" CHECK ("kind" IN ('agentd')),
        CONSTRAINT "chk_enrollment_codes_used" CHECK (("used_at" IS NULL) = ("used_by_device_id" IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_enrollment_codes_expires" ON "enrollment_codes" ("expires_at")`);

    await queryRunner.query(`
      CREATE TABLE "used_nonces" (
        "device_id" uuid NOT NULL,
        "nonce" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "pk_used_nonces" PRIMARY KEY ("device_id", "nonce"),
        CONSTRAINT "fk_used_nonces_device" FOREIGN KEY ("device_id") REFERENCES "devices" ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_used_nonces_expires" ON "used_nonces" ("expires_at")`);

    await queryRunner.query(`
      CREATE TABLE "settings" (
        "key" text NOT NULL,
        "value" jsonb NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_settings" PRIMARY KEY ("key")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "machine_merge_candidates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "machine_id" uuid NOT NULL,
        "candidate_machine_id" uuid NOT NULL,
        "reason" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "resolved_at" timestamptz,
        CONSTRAINT "pk_machine_merge_candidates" PRIMARY KEY ("id"),
        CONSTRAINT "uq_machine_merge_candidates_pair" UNIQUE ("machine_id", "candidate_machine_id"),
        CONSTRAINT "fk_merge_candidates_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_merge_candidates_candidate" FOREIGN KEY ("candidate_machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_merge_candidates_distinct" CHECK ("machine_id" <> "candidate_machine_id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_merge_candidates_candidate" ON "machine_merge_candidates" ("candidate_machine_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "machine_merge_candidates"`);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`DROP TABLE "used_nonces"`);
    await queryRunner.query(`DROP TABLE "enrollment_codes"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP CONSTRAINT "chk_devices_scopes"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "expires_at"`);
  }
}
