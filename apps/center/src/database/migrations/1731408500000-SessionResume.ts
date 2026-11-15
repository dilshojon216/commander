import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.14 "Davom ettirish": tugagan terminal sessiyani `claude --resume` bilan yangi tmux sessiyada davom ettirish.
 *
 *  - `commands`: yangi turlar `session.resume` va `session.close` (tmux sessiyani yopish) mavjud CHECK ro'yxatiga QO'SHILADI (boshqa migratsiyalar qo'shgan turlarga tegilmaydi;
 *    `down` faqat o'zinikini olib tashlaydi). Boshqa sxema o'zgarishi yo'q: sessiya qatori o'sha (xuddi shu claude session id),
 *    tmux sessiya nomi `commands.result.tmuxSession` da.
 */
const NEW_TYPES = ['session.resume', 'session.close'];

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

export class SessionResume1731408500000 implements MigrationInterface {
  name = 'SessionResume1731408500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Yangi tur bilan yozilgan buyruqlar bo'lsa ro'yxatni toraytirib bo'lmaydi (CHECK buzilardi): ularni o'chiramiz.
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = ANY($1)`, [NEW_TYPES]);
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, types.filter((t) => !NEW_TYPES.includes(t)));
  }
}
