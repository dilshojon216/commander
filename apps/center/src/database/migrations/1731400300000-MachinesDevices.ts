import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Identity jadvallari: `machines` (barqaror mashina identiteti) va `devices`
 * (enroll qilingan agentd / klientlar). Faqat ustunlar; enrollment mantiqi 0.6'da.
 *
 * Qaror: mashina identiteti hostname EMAS (macOS hostname tarmoqqa qarab o'zgaradi:
 * "X-MacBook-Pro.local" vs "X-MBP.SSS"). Identity manbalari:
 *   - `hardware_id` (IOPlatformUUID / /etc/machine-id'ning xeshi) va/yoki
 *   - shu mashinaga bog'langan `devices(kind='agentd')` public key'i.
 * `hostname` faqat oxirgi xabar qilingan, ma'lumot uchun maydon.
 * v0 ma'lumotdan yaratilgan mashinalar `identity_status='legacy_unverified'`
 * va `legacy_host` (v0 `host` satri) bilan; agentd enroll bo'lgach ular
 * `merged_into_id` orqali haqiqiy mashinaga birlashtiriladi.
 */
export class MachinesDevices1731400300000 implements MigrationInterface {
  name = 'MachinesDevices1731400300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Hostname'dan o'qiladigan, takrorlanmas slug: "users-mbp-sss-1a2b3c".
    await queryRunner.query(`
      CREATE FUNCTION commander_machine_slug(host text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT AS $$
        SELECT COALESCE(
                 NULLIF(trim(both '-' from lower(regexp_replace(host, '[^A-Za-z0-9]+', '-', 'g'))), ''),
                 'machine'
               ) || '-' || substr(md5(host), 1, 6)
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE "machines" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" text NOT NULL,
        "display_name" text,
        "hostname" text,
        "legacy_host" text,
        "hardware_id" text,
        "os" text,
        "tailnet_name" text,
        "identity_status" text NOT NULL DEFAULT 'legacy_unverified',
        "status" text NOT NULL DEFAULT 'active',
        "merged_into_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_seen_at" timestamptz,
        CONSTRAINT "pk_machines" PRIMARY KEY ("id"),
        CONSTRAINT "uq_machines_slug" UNIQUE ("slug"),
        CONSTRAINT "uq_machines_legacy_host" UNIQUE ("legacy_host"),
        CONSTRAINT "uq_machines_hardware_id" UNIQUE ("hardware_id"),
        CONSTRAINT "fk_machines_merged_into" FOREIGN KEY ("merged_into_id") REFERENCES "machines" ("id"),
        CONSTRAINT "chk_machines_identity_status" CHECK ("identity_status" IN ('verified', 'legacy_unverified')),
        CONSTRAINT "chk_machines_status" CHECK ("status" IN ('active', 'retired'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_machines_merged_into" ON "machines" ("merged_into_id") WHERE "merged_into_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "machine_id" uuid,
        "kind" text NOT NULL,
        "name" text,
        "public_key" bytea,
        "token_hash" text,
        "external_id" text,
        "scopes" text[] NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_used_at" timestamptz,
        "revoked_at" timestamptz,
        CONSTRAINT "pk_devices" PRIMARY KEY ("id"),
        CONSTRAINT "fk_devices_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "uq_devices_public_key" UNIQUE ("public_key"),
        CONSTRAINT "uq_devices_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "uq_devices_kind_external_id" UNIQUE ("kind", "external_id"),
        CONSTRAINT "chk_devices_kind" CHECK ("kind" IN ('agentd', 'web', 'menubar', 'mobile', 'telegram')),
        CONSTRAINT "chk_devices_public_key_len" CHECK ("public_key" IS NULL OR octet_length("public_key") = 32),
        CONSTRAINT "chk_devices_agentd_identity" CHECK ("kind" <> 'agentd' OR ("public_key" IS NOT NULL AND "machine_id" IS NOT NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_devices_machine_id" ON "devices" ("machine_id") WHERE "machine_id" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP TABLE "machines"`);
    await queryRunner.query(`DROP FUNCTION "commander_machine_slug"(text)`);
  }
}
