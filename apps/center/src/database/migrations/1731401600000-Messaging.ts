import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessiyalararo xabar (task 2.10, PLAN ADR "2.10").
 *
 *  - `messaging_groups`: guruh sozlamalari. Guruh kaliti: `repo_key` | `project:<uuid>` | `workspace:<nom>`. Sukut bo'yicha O'CHIQ
 *    (egasi dashboard'dan yoqmaguncha xabar yuborilmaydi/yetkazilmaydi); `auto_wake` ham, `telegram_questions` ham sukutda o'chiq.
 *  - `project_links`: egasi turli repo'larni bitta workspace'ga bog'laydi (`base_key` = repo_key | project:<uuid>; bir repo bitta workspace'da).
 *  - `session_roles`: sessiya roli (egasi yoki sessiyaning o'zi o'rnatgan). Qator yo'q = loyiha nomi/yo'lidan TAXMIN (hisoblanadi, saqlanmaydi).
 *  - `session_messages`: pochta qutisi. Har qabul qiluvchi uchun ALOHIDA qator (broadcast `batch_id` bilan birlashadi), shu sabab
 *    `delivered_at`/`read_at` qabul qiluvchi bo'yicha. Sarlavha <= 120, matn <= 4000 (CHECK + redakt). Saqlash muddati 30 kun (center tozalaydi).
 */
export class Messaging1731401600000 implements MigrationInterface {
  name = 'Messaging1731401600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "messaging_groups" (
        "group_key" text NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "auto_wake" boolean NOT NULL DEFAULT false,
        "telegram_questions" boolean NOT NULL DEFAULT false,
        "context" text NOT NULL DEFAULT '',
        "context_updated_at" timestamptz,
        "rules" jsonb NOT NULL DEFAULT '[]',
        "updated_by_device_id" uuid,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_messaging_groups" PRIMARY KEY ("group_key"),
        CONSTRAINT "chk_messaging_groups_context_len" CHECK (char_length("context") <= 16000)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "project_links" (
        "base_key" text NOT NULL,
        "workspace" text NOT NULL,
        "created_by_device_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_links" PRIMARY KEY ("base_key"),
        CONSTRAINT "chk_project_links_workspace" CHECK ("workspace" ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_project_links_workspace" ON "project_links" ("workspace")`);

    await queryRunner.query(`
      CREATE TABLE "session_roles" (
        "session_id" uuid NOT NULL,
        "role" text NOT NULL,
        "source" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_session_roles" PRIMARY KEY ("session_id"),
        CONSTRAINT "fk_session_roles_session" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_session_roles_source" CHECK ("source" IN ('owner', 'session')),
        CONSTRAINT "chk_session_roles_role" CHECK ("role" ~ '^[a-z0-9][a-z0-9 _.-]{0,31}$' AND "role" NOT IN ('owner', 'all', 'auto', 'hammasi'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "session_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_id" uuid NOT NULL,
        "group_key" text NOT NULL,
        "from_session_id" uuid,
        "from_role" text NOT NULL,
        "from_label" text NOT NULL DEFAULT '',
        "to_session_id" uuid NOT NULL,
        "to_role" text,
        "to_target" text NOT NULL,
        "kind" text NOT NULL,
        "subject" text NOT NULL,
        "body" text NOT NULL,
        "reply_to" uuid,
        "status" text NOT NULL DEFAULT 'pending',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "delivered_at" timestamptz,
        "read_at" timestamptz,
        CONSTRAINT "pk_session_messages" PRIMARY KEY ("id"),
        CONSTRAINT "fk_session_messages_from" FOREIGN KEY ("from_session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL,
        CONSTRAINT "fk_session_messages_to" FOREIGN KEY ("to_session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_session_messages_reply" FOREIGN KEY ("reply_to") REFERENCES "session_messages" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_session_messages_kind" CHECK ("kind" IN ('api_change', 'question', 'request', 'info', 'answer')),
        CONSTRAINT "chk_session_messages_status" CHECK ("status" IN ('pending', 'delivered', 'read')),
        CONSTRAINT "chk_session_messages_subject" CHECK (char_length("subject") BETWEEN 1 AND 120),
        CONSTRAINT "chk_session_messages_body" CHECK (char_length("body") BETWEEN 1 AND 4000)
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_session_messages_group" ON "session_messages" ("group_key", "created_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_session_messages_to_unread" ON "session_messages" ("to_session_id", "created_at") WHERE "read_at" IS NULL`);
    await queryRunner.query(`CREATE INDEX "idx_session_messages_batch" ON "session_messages" ("batch_id")`);
    await queryRunner.query(`CREATE INDEX "idx_session_messages_created" ON "session_messages" ("created_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "session_messages"`);
    await queryRunner.query(`DROP TABLE "session_roles"`);
    await queryRunner.query(`DROP TABLE "project_links"`);
    await queryRunner.query(`DROP TABLE "messaging_groups"`);
  }
}
