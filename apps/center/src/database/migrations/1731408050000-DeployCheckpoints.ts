import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 6.5 bir bosishda deploy + 6.9 git checkpoint'lar.
 *
 *  - `commands`: yangi turlar (`deploy.inspect|run|rollback`, `git.checkpoint|checkpoint_list|checkpoint_restore`) mavjud CHECK ro'yxatiga
 *    QO'SHILADI (boshqa migratsiyalar qo'shgan turlarga tegilmaydi; `down` faqat o'zinikini olib tashlaydi). Deploy chiqishi HECH QAYERDA
 *    saqlanmaydi: tarix `commands` qatorlaridan (maqsad, commit, xesh, qadam holatlari) olinadi, shu sabab alohida jadval yo'q.
 *  - `prompt_templates.big_task`: shablon "katta vazifa" deb belgilanadi (6.9: sessiya ochishdan oldin avto-checkpoint, sozlama yoqilgan bo'lsa).
 */
const NEW_TYPES = ['deploy.inspect', 'deploy.run', 'deploy.rollback', 'git.checkpoint', 'git.checkpoint_list', 'git.checkpoint_restore'];

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

export class DeployCheckpoints1731408050000 implements MigrationInterface {
  name = 'DeployCheckpoints1731408050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);
    await queryRunner.query(`ALTER TABLE "prompt_templates" ADD COLUMN "big_task" boolean NOT NULL DEFAULT false`);
    // deploy tarixi: loyiha + tur bo'yicha eng yangilari
    await queryRunner.query(
      `CREATE INDEX "idx_commands_project_deploy" ON "commands" ("project_id", "created_at" DESC) WHERE "type" IN ('deploy.run', 'deploy.rollback')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_commands_project_deploy"`);
    await queryRunner.query(`ALTER TABLE "prompt_templates" DROP COLUMN IF EXISTS "big_task"`);
    // Yangi tur bilan yozilgan buyruqlar bo'lsa ro'yxatni toraytirib bo'lmaydi (CHECK buzilardi): ularni o'chiramiz.
    await queryRunner.query(`DELETE FROM "commands" WHERE "type" = ANY($1)`, [NEW_TYPES]);
    const types = typesOf(await typeCheckDef(queryRunner));
    await setTypes(queryRunner, types.filter((t) => !NEW_TYPES.includes(t)));
  }
}
