import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remote Control (3.10).
 *
 * - `sessions.remote_control` (jsonb): `{enabled, name, since, url?}`; NULL = noma'lum (hech qachon o'zgartirilmagan).
 * - `commands.type` CHECK'iga `session.remote_control` qo'shiladi. Ro'yxat MAVJUD cheklovdan o'qiladi (qattiq yozilmaydi):
 *   parallel migratsiyalar qo'shgan boshqa turlar yo'qolmaydi. `down` faqat shu turni olib tashlaydi.
 */
const TYPE = 'session.remote_control';

async function typeCheckDef(q: QueryRunner): Promise<string> {
  const rows: Array<{ def: string }> = await q.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`,
  );
  const def = rows[0]?.def;
  if (!def) throw new Error('chk_commands_type not found');
  return def;
}

function typesOf(def: string): string[] {
  return [...def.matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1] as string);
}

async function setTypes(q: QueryRunner, types: string[]): Promise<void> {
  const list = types.map((t) => `'${t}'`).join(', ');
  await q.query(`ALTER TABLE "commands" DROP CONSTRAINT "chk_commands_type"`);
  await q.query(`ALTER TABLE "commands" ADD CONSTRAINT "chk_commands_type" CHECK ("type" IN (${list}))`);
}

export class RemoteControl1731403070000 implements MigrationInterface {
  name = 'RemoteControl1731403070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "remote_control" jsonb`);
    const types = typesOf(await typeCheckDef(queryRunner));
    if (!types.includes(TYPE)) await setTypes(queryRunner, [...types, TYPE]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = '${TYPE}'`);
    const types = typesOf(await typeCheckDef(queryRunner)).filter((t) => t !== TYPE);
    await setTypes(queryRunner, types);
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "remote_control"`);
  }
}
