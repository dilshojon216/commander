import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AgentIngestService } from '../../src/agent/agent-ingest.service.js';
import { MIGRATIONS } from '../../src/database/database.config.js';
import { MergeSubfolderProjects1731408400000 } from '../../src/database/migrations/1731408400000-MergeSubfolderProjects.js';
import { EventsService } from '../../src/events/events.service.js';
import { ProjectPartsService } from '../../src/projects/project-parts.service.js';
import { TaskSpansService } from '../../src/projects/task-spans.service.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb, openDataSource, pausePolicyJobs } from './helpers.js';

/**
 * Loyiha atributsiyasi: sessiya loyihasi BOSHLANGAN cwd bilan belgilanadi (cwd o'zgarsa ham o'zgarmaydi) va
 * pastki papka yangi loyiha ochmaydi; MergeSubfolderProjects migratsiyasi eski ma'lumotni tuzatadi.
 */
const ROOT = '/Users/me/working/commander';
type Ev = Parameters<AgentIngestService['ingestEvents']>[1][number];
type Rec = Parameters<AgentIngestService['ingestUsage']>[1][number];

let seq = 0;
const ev = (o: Record<string, unknown>): Ev =>
  ({ eventId: randomUUID(), event: 'PreToolUse', status: 'working', ts: Date.now() - 60_000 + seq++ * 1000, ...o }) as unknown as Ev;
const use = (o: Record<string, unknown>): Rec =>
  ({ requestId: randomUUID(), ts: Date.now() - 30_000 + seq++, model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, source: 'otel', ...o }) as unknown as Rec;

async function machine(ds: DataSource): Promise<string> {
  const rows: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ($1) RETURNING id`, [`m-${randomUUID().slice(0, 8)}`]);
  return rows[0]!.id;
}

describe('ingest: sessiya loyihasi yopishqoq', () => {
  let db: { url: string; drop: () => Promise<void> };
  let ds: DataSource;
  let ing: AgentIngestService;
  beforeAll(async () => {
    db = await createThrowawayDb();
    ds = await openDataSource(db.url);
    await ds.runMigrations();
    // Yangi bazada retention/cagg job'lari darhol ishga tushib FK qulflari bilan deadlock beradi (test artefakti): to'xtatiladi.
    await pausePolicyJobs(ds);
    const parts = new ProjectPartsService(ds);
    ing = new AgentIngestService(ds, new EventsService(ds), new RealtimeBus(), new TaskSpansService(parts), parts);
  });
  afterAll(async () => {
    await ds.destroy();
    await db.drop();
  });

  const projects = async (m: string): Promise<Array<{ path: string; kind: string }>> =>
    ds.query(`SELECT path, kind FROM projects WHERE machine_id = $1 ORDER BY path`, [m]);
  const sessionProject = async (m: string, s: string): Promise<string | null> =>
    (await ds.query(`SELECT p.path FROM sessions x LEFT JOIN projects p ON p.id = x.project_id WHERE x.machine_id = $1 AND x.claude_session_id = $2`, [m, s]))[0].path;

  it('git bo\'lmagan cwd pastki papkaga o\'tsa: project_id, token_usage va span o\'zgarmaydi, yangi loyiha ochilmaydi', async () => {
    const m = await machine(ds);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 's1', cwd: ROOT, rootKind: 'dir', event: 'SessionStart', status: 'idle' })]);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 's1', cwd: `${ROOT}/apps/dashboard`, rootKind: 'dir', taskKey: '1.4', taskSource: 'explicit' })]);
    await ing.ingestUsage(m, [use({ claudeSessionId: 's1', cwd: `${ROOT}/apps/dashboard` }), use({ claudeSessionId: 's1', cwd: ROOT })]);

    expect(await projects(m)).toEqual([{ path: ROOT, kind: 'dir' }]);
    expect(await sessionProject(m, 's1')).toBe(ROOT);
    const tu: Array<{ path: string }> = await ds.query(`SELECT p.path FROM token_usage t JOIN projects p ON p.id = t.project_id WHERE t.machine_id = $1`, [m]);
    expect(tu.map((r) => r.path)).toEqual([ROOT, ROOT]);
    const sp: Array<{ path: string }> = await ds.query(`SELECT p.path FROM session_task_spans s JOIN projects p ON p.id = s.project_id WHERE s.machine_id = $1`, [m]);
    expect(sp.map((r) => r.path)).toEqual([ROOT]);
  });

  it('sessiya pastki papkada boshlansa ham (ota loyiha ma\'lum) ota loyihaga bog\'lanadi', async () => {
    const m = await machine(ds);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'a', cwd: ROOT, rootKind: 'dir' })]);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'b', cwd: `${ROOT}/docs`, rootKind: 'dir' })]);
    expect(await sessionProject(m, 'b')).toBe(ROOT);
    expect((await projects(m)).map((p) => p.path)).toEqual([ROOT]);
  });

  it('git ildizi (rootKind=git) ota dir loyihaga yutilmaydi: o\'z git loyihasi', async () => {
    const m = await machine(ds);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'a', cwd: '/home/u', rootKind: 'dir' })]);
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'g', cwd: '/home/u/repo', rootKind: 'git' })]);
    expect(await sessionProject(m, 'g')).toBe('/home/u/repo');
    expect(await projects(m)).toEqual([{ path: '/home/u', kind: 'dir' }, { path: '/home/u/repo', kind: 'git' }]);
  });

  it('boshqa mashinadagi loyiha ota bo\'lmaydi; cwd yo\'q sessiya NULL, keyin birinchi cwd belgilaydi', async () => {
    const m1 = await machine(ds);
    const m2 = await machine(ds);
    await ing.ingestEvents(m1, [ev({ claudeSessionId: 'a', cwd: '/w/x', rootKind: 'dir' })]);
    await ing.ingestEvents(m2, [ev({ claudeSessionId: 'b', cwd: '/w/x/y', rootKind: 'dir' })]);
    expect(await sessionProject(m2, 'b')).toBe('/w/x/y');
    // usage sessiyadan oldin kelsa ham cwd bo'yicha; eski agentd (rootKind yo'q) ham ishlaydi
    await ing.ingestEvents(m1, [ev({ claudeSessionId: 'old', cwd: '/w/x/z' })]);
    expect(await sessionProject(m1, 'old')).toBe('/w/x');
  });
});

describe('MergeSubfolderProjects migratsiyasi', () => {
  it('bolalarni eng yaqin tirik otaga ko\'chiradi, to\'qnashuvlarni hal qiladi, git va boshqa mashinaga tegmaydi, idempotent', async () => {
    const db = await createThrowawayDb();
    const pre = await openDataSource(db.url, MIGRATIONS.slice(0, MIGRATIONS.indexOf(MergeSubfolderProjects1731408400000)));
    try {
      await pre.runMigrations();
      await pausePolicyJobs(pre);
      const m1 = await machine(pre);
      const m2 = await machine(pre);
      const mk = async (m: string, path: string, kind: string): Promise<string> =>
        (await pre.query(`INSERT INTO projects (machine_id, path, name, kind) VALUES ($1, $2, $2, $3) RETURNING id`, [m, path, kind]))[0].id;
      const root = await mk(m1, ROOT, 'dir');
      const apps = await mk(m1, `${ROOT}/apps`, 'dir'); // bola (-> root)
      const dash = await mk(m1, `${ROOT}/apps/dashboard`, 'dir'); // bola, eng yaqin ota apps o'chadi -> root
      const sibling = await mk(m1, `${ROOT}-other`, 'dir'); // prefiks bor, lekin chegara emas -> tegilmaydi
      const gitRepo = await mk(m1, `${ROOT}/vendored`, 'git'); // git: tegilmaydi
      const rootFs = await mk(m1, '/', 'dir');
      const home = await mk(m1, '/home/dev', 'dir'); // '/' ota bo'lmaydi
      const other = await mk(m2, `${ROOT}/apps`, 'dir'); // boshqa mashina: ota yo'q

      for (const [p, k] of [[root, 'T-1'], [apps, 'T-1'], [dash, 'T-1'], [dash, 'T-2'], [other, 'T-1']] as const) {
        await pre.query(`INSERT INTO project_tasks (project_id, task_key, title, status, "order") VALUES ($1, $2, 't', 'todo', 1)`, [p, k]);
      }
      await pre.query(`INSERT INTO task_board (project_id, task_key, board_column) VALUES ($1, 'T-2', 'doing'), ($2, 'T-2', 'done')`, [dash, apps]);
      await pre.query(`INSERT INTO daily_summaries (project_id, day, summary, model) VALUES ($1, '2026-11-13', 's', 'm')`, [apps]);
      const sess = async (p: string, id: string): Promise<void> => {
        await pre.query(
          `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, status, started_at, status_since, last_seen_at)
           VALUES ($1, $2, $3, '/x', 'x', 'idle', now(), now(), now())`,
          [m1, id, p],
        );
      };
      await sess(dash, 'sd');
      await sess(apps, 'sa');
      const tu = async (p: string, n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          await pre.query(`INSERT INTO token_usage (ts, machine_id, request_id, project_id, model, source) VALUES (now(), $1, $2, $3, 'm', 'otel')`, [m1, randomUUID(), p]);
        }
      };
      await tu(dash, 3);
      await tu(apps, 2);
      await tu(root, 1);

      await openDataSource(db.url).then(async (full) => {
        const done = await full.runMigrations();
        expect(done.map((x) => x.name).slice(0, 2)).toEqual(['MergeSubfolderProjects1731408400000', 'SessionResume1731408500000']);
        const left: Array<{ id: string }> = await full.query(`SELECT id FROM projects ORDER BY path`);
        expect(left.map((r) => r.id).sort()).toEqual([root, sibling, gitRepo, rootFs, home, other].sort());

        const count = async (sql: string, p: string): Promise<number> => Number((await full.query(sql, [p]))[0].n);
        expect(await count(`SELECT count(*) n FROM sessions WHERE project_id = $1`, root)).toBe(2);
        expect(await count(`SELECT count(*) n FROM token_usage WHERE project_id = $1`, root)).toBe(6);
        // project_tasks: root'da T-1 (o'zniki ustun), dash T-2 -> root; ikkinchi T-1 dublikatlari o'chadi
        const tasks: Array<{ task_key: string }> = await full.query(`SELECT task_key FROM project_tasks WHERE project_id = $1 ORDER BY 1`, [root]);
        expect(tasks.map((t) => t.task_key)).toEqual(['T-1', 'T-2']);
        expect(await count(`SELECT count(*) n FROM project_tasks WHERE project_id = $1`, other)).toBe(1);
        // task_board: ikki bola bir kalitga to'qnashdi -> bittasi qoladi
        expect(await count(`SELECT count(*) n FROM task_board WHERE project_id = $1`, root)).toBe(1);
        expect(await count(`SELECT count(*) n FROM daily_summaries WHERE project_id = $1`, root)).toBe(1);

        // idempotent: qayta chaqirish hech narsani o'zgartirmaydi
        const qr = full.createQueryRunner();
        await qr.startTransaction();
        await new MergeSubfolderProjects1731408400000().up(qr);
        await qr.commitTransaction();
        await qr.release();
        expect((await full.query(`SELECT count(*) n FROM projects`))[0].n).toBe('6');
        await full.destroy();
      });
    } finally {
      await pre.destroy().catch(() => undefined);
      await db.drop();
    }
  });
});
