import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.6 log ko'ruvchi + 6.4 hodisadan tekshiruvga.
 *
 *  - `commands`: yangi tur `logs.tail` (mavjud ro'yxatga qo'shiladi: boshqa migratsiyalar qo'shgan turlarga tegilmaydi; `down` faqat
 *    o'zinikini olib tashlaydi). Log matni HECH QAYERDA saqlanmaydi: `commands.payload` da faqat manba turi/nomi.
 *  - `incident_investigations`: hodisa (server hodisasi `health_incidents` yoki watchdog ogohlantirishi `watchdog_alerts`) -> tekshiruv
 *    buyrug'i (`session.start`, plan rejimi). Sessiya va uning holati o'qishda `commands` / `sessions` bilan bog'lanadi
 *    (tekshiruv sessiyasi tugagach holat hodisa qatorida ko'rinadi; jadvalda matn yo'q). `subject_id` ataylab FK emas (ikki jadval).
 */
const NEW_TYPES = ['logs.tail'];

async function typeCheckDef(q: QueryRunner): Promise<string> {
  const rows: Array<{ def: string }> = await q.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`,
  );
  const def = rows[0]?.def;
  if (!def) throw new Error('chk_commands_type not found');
  return def;
}

const typesOf = (def: string): string[] => [...def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] as string);

async function setTypes(q: QueryRunner, types: string[]): Promise<void> {
  const list = types.map((t) => `'${t}'`).join(', ');
  await q.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
  await q.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK ("type" IN (${list}))`);
}

export class LogsInvestigations1731407100000 implements MigrationInterface {
  name = 'LogsInvestigations1731407100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);

    await queryRunner.query(`
      CREATE TABLE "incident_investigations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subject_kind" text NOT NULL,
        "subject_id" uuid NOT NULL,
        "machine_id" uuid NOT NULL,
        "command_id" uuid NOT NULL,
        "requested_by_device_id" uuid,
        "model" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_incident_investigations_machine" FOREIGN KEY ("machine_id") REFERENCES "machines" ("id"),
        CONSTRAINT "fk_incident_investigations_command" FOREIGN KEY ("command_id") REFERENCES "commands" ("id") ON DELETE CASCADE,
        CONSTRAINT "uq_incident_investigations_command" UNIQUE ("command_id"),
        CONSTRAINT "chk_incident_investigations_kind" CHECK ("subject_kind" IN ('health', 'watchdog'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_incident_investigations_subject" ON "incident_investigations" ("subject_kind", "subject_id", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX "idx_incident_investigations_machine" ON "incident_investigations" ("machine_id", "created_at" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "incident_investigations"`);
    // Yangi tur bilan yozilgan buyruqlar bo'lsa ro'yxatni toraytirib bo'lmaydi (CHECK buzilardi): ularni o'chiramiz (log matni baribir yo'q).
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = ANY($1)`, [NEW_TYPES]);
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, types.filter((t) => !NEW_TYPES.includes(t)));
  }
}
