import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remote amallar uchun `commands` va append-only `audit_log`.
 *
 * commands: har bir masofaviy amal (RCE yuzasi) shu yerdan o'tadi. `status`
 * hayot sikli PLAN §7 dagi `state` bilan bir xil. `UNIQUE(requested_by_device_id, nonce)`
 * replay'ga qarshi; `expires_at` majburiy.
 *
 * audit_log:
 * - UPDATE/DELETE/TRUNCATE trigger bilan bloklanadi.
 * - Hash-zanjir BEFORE INSERT trigger'ida hisoblanadi (ilova hisoblamaydi):
 *   advisory lock ostida `id` navbatdan olinadi, oldingi qatorning `hash`i
 *   `prev_hash`ga yoziladi, `hash = sha256(prev_hash | maydonlar)`. Shunda zanjir
 *   yozuvchidan qat'i nazar izchil va id tartibi = zanjir tartibi.
 *   `audit_log_verify()` birinchi buzilgan qator id'sini qaytaradi (butun bo'lsa NULL).
 * - Cheklov: compose'da ilova DB roli superuser (POSTGRES_USER), superuser trigger'ni
 *   o'chira oladi. PLAN §7 dagi "ilova roliga UPDATE/DELETE huquqi yo'q" ni qo'llash
 *   uchun alohida cheklangan rol kerak (kelgusi hardening).
 */
export class CommandsAudit1731400700000 implements MigrationInterface {
  name = 'CommandsAudit1731400700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "commands" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "type" text NOT NULL,
        "machine_id" uuid NOT NULL,
        "session_id" uuid,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "status" text NOT NULL DEFAULT 'pending',
        "requested_by_device_id" uuid NOT NULL,
        "confirmed_by_device_id" uuid,
        "nonce" text NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "result" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "confirmed_at" timestamptz,
        "sent_at" timestamptz,
        "acked_at" timestamptz,
        "finished_at" timestamptz,
        CONSTRAINT "pk_commands" PRIMARY KEY ("id"),
        CONSTRAINT "uq_commands_requester_nonce" UNIQUE ("requested_by_device_id", "nonce"),
        CONSTRAINT "fk_commands_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_commands_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_commands_requested_by" FOREIGN KEY ("requested_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "fk_commands_confirmed_by" FOREIGN KEY ("confirmed_by_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "chk_commands_type" CHECK (
          "type" IN ('session.start', 'session.prompt', 'session.interrupt', 'session.stop', 'agent.reconfigure')
        ),
        CONSTRAINT "chk_commands_status" CHECK (
          "status" IN ('awaiting_confirmation', 'pending', 'sent', 'acked', 'running', 'done', 'failed', 'expired', 'rejected')
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_commands_machine_open" ON "commands" ("machine_id", "created_at")
         WHERE "status" IN ('awaiting_confirmation', 'pending', 'sent', 'acked', 'running')`,
    );
    await queryRunner.query(`CREATE INDEX "idx_commands_session_id" ON "commands" ("session_id") WHERE "session_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "idx_commands_confirmed_by" ON "commands" ("confirmed_by_device_id") WHERE "confirmed_by_device_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" bigint NOT NULL,
        "ts" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "actor_device_id" uuid,
        "actor_kind" text NOT NULL,
        "action" text NOT NULL,
        "target" text,
        "details" jsonb NOT NULL DEFAULT '{}',
        "ip" inet,
        "prev_hash" text,
        "hash" text NOT NULL,
        CONSTRAINT "pk_audit_log" PRIMARY KEY ("id"),
        CONSTRAINT "fk_audit_log_actor" FOREIGN KEY ("actor_device_id") REFERENCES "devices" ("id"),
        CONSTRAINT "chk_audit_log_actor_kind" CHECK (
          "actor_kind" IN ('agentd', 'web', 'menubar', 'mobile', 'telegram', 'system')
        )
      )
    `);
    await queryRunner.query(`CREATE SEQUENCE "audit_log_id_seq" OWNED BY "audit_log"."id"`);
    await queryRunner.query(`CREATE INDEX "idx_audit_log_ts" ON "audit_log" ("ts" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_audit_log_actor" ON "audit_log" ("actor_device_id") WHERE "actor_device_id" IS NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION audit_log_row_hash(
        prev text, id bigint, ts timestamptz, actor uuid, kind text, action text, target text, details jsonb, ip inet
      ) RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT encode(sha256(convert_to(concat_ws('|',
          COALESCE(prev, repeat('0', 64)), id::text,
          (extract(epoch FROM ts) * 1000000)::bigint::text,
          COALESCE(actor::text, ''), kind, action,
          COALESCE(target, ''), details::text, COALESCE(host(ip), '')
        ), 'UTF8')), 'hex')
      $$
    `);
    await queryRunner.query(`
      CREATE FUNCTION audit_log_before_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        last_hash text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('commander.audit_log.chain'));
        SELECT "hash" INTO last_hash FROM "audit_log" ORDER BY "id" DESC LIMIT 1;
        NEW."id" := nextval('audit_log_id_seq');
        NEW."prev_hash" := last_hash;
        NEW."hash" := audit_log_row_hash(
          last_hash, NEW."id", NEW."ts", NEW."actor_device_id", NEW."actor_kind",
          NEW."action", NEW."target", NEW."details", NEW."ip"
        );
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_log_chain BEFORE INSERT ON "audit_log"
        FOR EACH ROW EXECUTE FUNCTION audit_log_before_insert()
    `);
    await queryRunner.query(`
      CREATE FUNCTION audit_log_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_log_no_update_delete BEFORE UPDATE OR DELETE ON "audit_log"
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
        FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()
    `);
    await queryRunner.query(`
      CREATE FUNCTION audit_log_verify() RETURNS bigint
      LANGUAGE sql STABLE AS $$
        SELECT a."id"
          FROM (SELECT l.*, lag(l."hash") OVER (ORDER BY l."id") AS expected_prev FROM "audit_log" l) a
         WHERE a."prev_hash" IS DISTINCT FROM a.expected_prev
            OR a."hash" <> audit_log_row_hash(
                 a."prev_hash", a."id", a."ts", a."actor_device_id", a."actor_kind",
                 a."action", a."target", a."details", a."ip")
         ORDER BY a."id" LIMIT 1
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION "audit_log_verify"()`);
    await queryRunner.query(`DROP TABLE "audit_log"`);
    await queryRunner.query(`DROP FUNCTION "audit_log_immutable"()`);
    await queryRunner.query(`DROP FUNCTION "audit_log_before_insert"()`);
    await queryRunner.query(
      `DROP FUNCTION "audit_log_row_hash"(text, bigint, timestamptz, uuid, text, text, text, jsonb, inet)`,
    );
    await queryRunner.query(`DROP TABLE "commands"`);
  }
}
