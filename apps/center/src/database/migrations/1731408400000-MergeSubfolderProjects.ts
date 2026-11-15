import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ma'lumotni tuzatish: pastki papka `dir` loyihalarini eng yaqin ota loyihaga birlashtirish.
 *
 * Sabab: git bo'lmagan loyihada (`kind='dir'`) sessiya cwd'si pastki papkaga o'tganda (`cd apps/dashboard`) har bir
 * papka uchun yangi `dir` loyiha yaratilib, sessiya shunga ko'chirilgan edi (kod tuzatildi: loyiha sessiya BOSHIDA
 * belgilanadi, `projects/project-resolution-logic.ts`). Bu migratsiya eskilarini tuzatadi.
 *
 * Qoida: bir mashinada yo'li boshqa loyiha yo'lining QAT'IY ichida bo'lgan `dir` loyiha (`/`, `C:/` ota bo'lmaydi)
 * "bola" hisoblanadi. Bola uchun nishon = eng yaqin ota, LEKIN o'zi ham bola bo'lmagan (zanjir: c -> b -> a bo'lsa
 * ikkalasi ham a ga; b o'chiriladi). Git loyihalarga tegilmaydi. Hamma havolalar nishonga ko'chiriladi, so'ng bola o'chiriladi.
 *
 * Unikal cheklovli jadvallarda (project_id kalitning bir qismi) to'qnashgan bola qatorlari avval o'chiriladi
 * (nishondagisi ustun; bir nechta bola orasida bittasi qoladi), keyin UPDATE. Hammasi to'plamli (set-based) so'rovlar:
 * `token_usage` (hypertable) bitta UPDATE bilan; `idx_token_usage_project_ts` indeksi bo'yicha. Siqilgan chunk'larda
 * UPDATE TimescaleDB 2.11+ da ishlaydi. `token_usage_daily_by_project` cagg'i siyosat oynasida (25 kun) o'zi qayta
 * hisoblanadi (UPDATE invalidatsiya yozadi); transaksiya ichida qo'lda refresh qilinmaydi.
 *
 * Idempotent: ikkinchi ishga tushirishda bola topilmaydi, hech narsa o'zgarmaydi.
 */
interface UniqueTable {
  table: string;
  /** project_id bilan birga unikal kalitni tashkil qiluvchi ustunlar (yoki `t2` jadval aliasli ifoda). */
  keys: string[];
  where?: string;
}

const UNIQUE_TABLES: UniqueTable[] = [
  { table: 'project_snapshots', keys: ['hash'] },
  { table: 'project_tasks', keys: ['task_key'] },
  { table: 'task_board', keys: ['task_key'] },
  { table: 'daily_summaries', keys: ['day'] },
  { table: 'project_prs', keys: ['number'] },
  { table: 'project_ci_status', keys: ['branch'] },
  { table: 'task_commits', keys: ['sha', 'task_key'] },
  { table: 'prompt_templates', keys: ['lower(t2."name")'], where: `t2."scope" = 'project'` },
];

/** Unikal cheklovsiz jadvallar (watchdog_alerts'da FK yo'q, lekin ustun bor). */
const PLAIN_TABLES = [
  'sessions',
  'token_usage',
  'commands',
  'session_task_spans',
  'task_events',
  'task_queue',
  'orchestrations',
  'session_summaries',
  'project_decisions',
  'project_scans',
  'watchdog_alerts',
];

export class MergeSubfolderProjects1731408400000 implements MigrationInterface {
  name = 'MergeSubfolderProjects1731408400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TEMP TABLE "_proj_merge" ON COMMIT DROP AS
      WITH anc AS (
        SELECT c."id" AS child_id, a."id" AS anc_id, length(rtrim(a."path", '/')) AS len
          FROM "projects" c
          JOIN "projects" a
            ON a."machine_id" = c."machine_id" AND a."id" <> c."id"
           AND a."path" <> '' AND a."path" <> '/' AND a."path" !~ '^[A-Za-z]:/?$'
           AND rtrim(a."path", '/') <> rtrim(c."path", '/')
           AND starts_with(c."path", rtrim(a."path", '/') || '/')
         WHERE c."kind" = 'dir'
      ),
      children AS (SELECT DISTINCT child_id FROM anc)
      SELECT DISTINCT ON (x.child_id) x.child_id, x.anc_id AS target_id
        FROM anc x
       WHERE x.anc_id NOT IN (SELECT child_id FROM children)
       ORDER BY x.child_id, x.len DESC
    `);

    for (const u of UNIQUE_TABLES) {
      const part = u.keys.map((k) => (k.includes('(') ? k : `t2."${k}"`)).join(', ');
      await queryRunner.query(`
        DELETE FROM "${u.table}" t USING (
          SELECT t2.ctid AS rid,
                 row_number() OVER (
                   PARTITION BY COALESCE(m.target_id, t2."project_id"), ${part}
                   ORDER BY (m.child_id IS NULL) DESC, t2.ctid
                 ) AS rn
            FROM "${u.table}" t2
            LEFT JOIN "_proj_merge" m ON m.child_id = t2."project_id"
           WHERE t2."project_id" IN (SELECT target_id FROM "_proj_merge" UNION SELECT child_id FROM "_proj_merge")
             ${u.where ? `AND ${u.where}` : ''}
        ) d
        WHERE t.ctid = d.rid AND d.rn > 1
      `);
    }

    for (const table of [...UNIQUE_TABLES.map((u) => u.table), ...PLAIN_TABLES]) {
      await queryRunner.query(`UPDATE "${table}" t SET "project_id" = m.target_id FROM "_proj_merge" m WHERE t."project_id" = m.child_id`);
    }

    await queryRunner.query(`DELETE FROM "projects" WHERE "id" IN (SELECT child_id FROM "_proj_merge")`);
  }

  public async down(): Promise<void> {
    // Qaytarib bo'lmaydi: birlashtirilgan pastki papka loyihalari va ularning havolalari ma'lumot sifatida saqlanmagan
    // (bu noto'g'ri bo'lingan ma'lumotni tuzatish edi). Bo'sh (no-op).
  }
}
