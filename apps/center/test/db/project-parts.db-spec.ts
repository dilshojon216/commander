import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { ProjectSnapshotPayload, SnapshotPart } from '@commander/contracts';
import { ProjectPartsResponseSchema } from '@commander/contracts';
import { AgentIngestService } from '../../src/agent/agent-ingest.service.js';
import { EventsService } from '../../src/events/events.service.js';
import { DailyService } from '../../src/projects/daily.service.js';
import { ProjectPartsService } from '../../src/projects/project-parts.service.js';
import { ProjectSnapshotService } from '../../src/projects/project-snapshot.service.js';
import { ProjectWorkDataService } from '../../src/projects/project-work-data.service.js';
import { TaskSpansService } from '../../src/projects/task-spans.service.js';
import { TaskStatsService } from '../../src/projects/task-stats.service.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb, openDataSource, pausePolicyJobs } from './helpers.js';

/** 6.15: qismlar saqlanishi, sessiya qismi (start_cwd bo'yicha), span atributsiyasi, o'qish API'si, migratsiya up/down. */
const ROOT = '/Users/me/working/agro';
type Ev = Parameters<AgentIngestService['ingestEvents']>[1][number];
type Rec = Parameters<AgentIngestService['ingestUsage']>[1][number];
let seq = 0;
const ev = (o: Record<string, unknown>): Ev => ({ eventId: randomUUID(), event: 'PreToolUse', status: 'working', ts: Date.now() - 600_000 + seq++ * 1000, ...o }) as unknown as Ev;
const use = (o: Record<string, unknown>): Rec =>
  ({ requestId: randomUUID(), ts: Date.now() - 300_000 + seq++, model: 'm', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, source: 'otel', ...o }) as unknown as Rec;

const mkPart = (path: string, items: Array<[string, 'todo' | 'doing' | 'done', string?]>): SnapshotPart => {
  const counts = { todo: 0, doing: 0, done: 0, unknown: 0, total: items.length };
  for (const [, s] of items) counts[s] += 1;
  return {
    path,
    name: path.split('/').pop()!,
    planFiles: [`${path}/TODO.md`],
    counts,
    items: items.map(([key, status, doneOn]) => ({ key, title: `Band ${key}`, phase: 'Faza', status, ...(doneOn ? { doneOn } : {}) })),
    itemsTruncated: false,
    readTruncated: false,
  };
};
let hashN = 0;
const snap = (parts: SnapshotPart[] | undefined, extra: Partial<ProjectSnapshotPayload> = {}): ProjectSnapshotPayload =>
  ({ path: ROOT, name: 'agro', kind: 'dir', commits: [], hash: String(++hashN).padStart(64, '0'), takenAt: Date.now() - 1000 + hashN, ...(parts ? { parts } : {}), ...extra }) as ProjectSnapshotPayload;

describe('6.15 loyiha qismlari', () => {
  let db: { url: string; drop: () => Promise<void> };
  let ds: DataSource;
  let ing: AgentIngestService;
  let snaps: ProjectSnapshotService;
  let parts: ProjectPartsService;
  let daily: DailyService;
  let machineId: string;
  let projectId: string;

  const part = async (sid: string): Promise<string | null> => (await ds.query(`SELECT part FROM sessions WHERE machine_id = $1 AND claude_session_id = $2`, [machineId, sid]))[0].part;

  beforeAll(async () => {
    db = await createThrowawayDb();
    ds = await openDataSource(db.url);
    await ds.runMigrations();
    await pausePolicyJobs(ds);
    parts = new ProjectPartsService(ds);
    ing = new AgentIngestService(ds, new EventsService(ds), new RealtimeBus(), new TaskSpansService(parts), parts);
    snaps = new ProjectSnapshotService(ds, new RealtimeBus(), parts);
    daily = new DailyService(ds, new TaskStatsService(ds), new ProjectWorkDataService(ds));
    machineId = (await ds.query(`INSERT INTO machines (slug) VALUES ('m-parts') RETURNING id`))[0].id;
  });
  afterAll(async () => {
    await ds.destroy();
    await db.drop();
  });

  it('qismlar bo\'lmaganda sessiya qismi NULL (ildiz), keyin snapshot kelganda start_cwd bo\'yicha belgilanadi (bir marta)', async () => {
    await ing.ingestEvents(machineId, [
      ev({ claudeSessionId: 'be', cwd: `${ROOT}/backend-services/src`, rootKind: 'dir', event: 'SessionStart', status: 'idle' }),
      ev({ claudeSessionId: 'web', cwd: `${ROOT}/web-app`, rootKind: 'dir', event: 'SessionStart', status: 'idle' }),
      ev({ claudeSessionId: 'root', cwd: ROOT, rootKind: 'dir', event: 'SessionStart', status: 'idle' }),
    ]);
    projectId = (await ds.query(`SELECT id FROM projects WHERE machine_id = $1`, [machineId]))[0].id;
    expect(await part('be')).toBeNull();

    // sessiya keyin boshqa papkaga o'tadi: cwd o'zgaradi, start_cwd qoladi
    await ing.ingestEvents(machineId, [ev({ claudeSessionId: 'be', cwd: `${ROOT}/web-app`, rootKind: 'dir' })]);
    expect((await ds.query(`SELECT start_cwd, cwd FROM sessions WHERE claude_session_id = 'be'`))[0]).toEqual({ start_cwd: `${ROOT}/backend-services/src`, cwd: `${ROOT}/web-app` });

    await snaps.ingest(machineId, snap([mkPart('backend-services', [['1', 'done', '2026-08-03'], ['2', 'todo'], ['3', 'doing']]), mkPart('web-app', [['1', 'todo'], ['2', 'todo']])]));
    expect(await part('be')).toBe('backend-services');
    expect(await part('web')).toBe('web-app');
    expect(await part('root')).toBe('');
  });

  it('project_tasks: qism kaliti nomlar maydonida (1 va 1 to\'qnashmaydi), ildiz tegilmaydi; task_events baseline', async () => {
    const rows: Array<{ task_key: string; part: string; done_on: string | null }> = await ds.query(
      `SELECT task_key, part, to_char(done_on, 'YYYY-MM-DD') AS done_on FROM project_tasks WHERE project_id = $1 ORDER BY task_key`,
      [projectId],
    );
    expect(rows.map((r) => r.task_key)).toEqual(['backend-services:1', 'backend-services:2', 'backend-services:3', 'web-app:1', 'web-app:2']);
    expect(rows[0]).toMatchObject({ part: 'backend-services', done_on: '2026-08-03' });
    // birinchi ko'rinishda bajarilgan band "bugun yopildi" hodisasi bo'lmaydi
    expect(await ds.query(`SELECT 1 FROM task_events WHERE project_id = $1`, [projectId])).toHaveLength(0);
  });

  it('keyingi snapshot: holat o\'zgarishi hodisa; qism yo\'qolsa o\'chadi; eski agentd (parts yo\'q) tegmaydi', async () => {
    await snaps.ingest(machineId, snap([mkPart('backend-services', [['1', 'done', '2026-08-03'], ['2', 'done'], ['3', 'doing']]), mkPart('web-app', [['1', 'todo'], ['2', 'todo']])]));
    const ev1: Array<{ task_key: string; from_status: string; to_status: string }> = await ds.query(`SELECT task_key, from_status, to_status FROM task_events WHERE project_id = $1`, [projectId]);
    expect(ev1).toEqual([{ task_key: 'backend-services:2', from_status: 'todo', to_status: 'done' }]);

    await snaps.ingest(machineId, snap(undefined, { tasksMd: '| # | Task |\n|---|---|\n| 1.1 | ✅ Ildiz |\n' }));
    const keys: Array<{ task_key: string }> = await ds.query(`SELECT task_key FROM project_tasks WHERE project_id = $1 ORDER BY task_key`, [projectId]);
    expect(keys.map((k) => k.task_key)).toEqual(['1.1', 'backend-services:1', 'backend-services:2', 'backend-services:3', 'web-app:1', 'web-app:2']);

    await snaps.ingest(machineId, snap([mkPart('backend-services', [['1', 'done'], ['2', 'done'], ['3', 'doing']])], { tasksMd: '| # | Task |\n|---|---|\n| 1.1 | ✅ Ildiz |\n' }));
    expect(await ds.query(`SELECT 1 FROM project_parts WHERE project_id = $1 AND part = 'web-app'`, [projectId])).toHaveLength(0);
    expect(await ds.query(`SELECT 1 FROM project_tasks WHERE project_id = $1 AND part = 'web-app'`, [projectId])).toHaveLength(0);
  });

  it('span atributsiyasi: qism sessiyasi markeri qism vazifasiga; ildiz sessiyasi ildiz vazifasiga', async () => {
    await ing.ingestEvents(machineId, [ev({ claudeSessionId: 'be', cwd: `${ROOT}/web-app`, rootKind: 'dir', taskKey: '3', taskSource: 'explicit' })]);
    await ing.ingestEvents(machineId, [ev({ claudeSessionId: 'root', cwd: ROOT, rootKind: 'dir', taskKey: '1.1', taskSource: 'explicit' })]);
    const spans: Array<{ session_id: string; task_key: string }> = await ds.query(`SELECT session_id, task_key FROM session_task_spans WHERE machine_id = $1 ORDER BY session_id`, [machineId]);
    expect(spans).toEqual([{ session_id: 'be', task_key: 'backend-services:3' }, { session_id: 'root', task_key: '1.1' }]);
  });

  it('GET parts: progress (agentd sanog\'i), xulosa, sessiya/token qism bo\'yicha', async () => {
    await ing.ingestUsage(machineId, [use({ claudeSessionId: 'be', cwd: ROOT }), use({ claudeSessionId: 'be', cwd: ROOT }), use({ claudeSessionId: 'root', cwd: ROOT })]);
    const res = ProjectPartsResponseSchema.parse(await parts.list(projectId));
    expect(res.parts.map((p) => p.part)).toEqual(['', 'backend-services']);
    const be = res.parts[1]!;
    expect(be).toMatchObject({ name: 'backend-services', summary: { done: 2, doing: 1, total: 3 }, percent: 67, sessions: 1 });
    expect(be.tokens.totalTokens).toBe(30);
    expect(be.recentDone.map((d) => d.key)).toEqual(['2', '1']);
    expect(be.byPhase).toEqual([{ phase: 'Faza', done: 2, total: 3 }]);
    const root = res.parts[0]!;
    expect(root.summary).toMatchObject({ done: 1, total: 1 });
    expect(root.tokens.totalTokens).toBe(15);
  });

  it('kunlik ko\'rinish qism bo\'yicha filtrlanadi', async () => {
    const all = await daily.daily(projectId, undefined, undefined);
    const forPart = await daily.daily(projectId, undefined, undefined, 'backend-services');
    const forRoot = await daily.daily(projectId, undefined, undefined, '');
    expect(all.days[0]!.tasks.map((t) => t.taskKey).sort()).toEqual(['1.1', 'backend-services:3']);
    expect(forPart.days[0]!.tasks.map((t) => t.taskKey)).toEqual(['backend-services:3']);
    expect(forRoot.days[0]!.tasks.map((t) => t.taskKey)).toEqual(['1.1']);
    expect(forPart.days[0]!.totals.sessions).toBe(1);
    await expect(daily.daily(projectId, undefined, undefined, '../x')).rejects.toThrow();
  });

  it('overview (Telegram /p)', async () => {
    const o = await parts.overview(null);
    expect(o).toHaveLength(1);
    expect(o[0]!.parts.map((p) => [p.part, p.done, p.total])).toEqual([['', 1, 1], ['backend-services', 2, 3]]);
    expect(await parts.overview('yo\'q-loyiha')).toEqual([]);
  });

  it('migratsiya: mavjud qatorlar ildiz (part=\'\'), sessions.part NULL; down qism qatorlarini olib tashlaydi', async () => {
    const d2 = await createThrowawayDb();
    const pre = await openDataSource(d2.url);
    try {
      await pre.runMigrations();
      await pausePolicyJobs(pre);
      const m = (await pre.query(`INSERT INTO machines (slug) VALUES ('m2') RETURNING id`))[0].id;
      const p = (await pre.query(`INSERT INTO projects (machine_id, path, name, kind) VALUES ($1, '/x', 'x', 'dir') RETURNING id`, [m]))[0].id;
      await pre.query(`INSERT INTO project_tasks (project_id, task_key, title, status, "order", part) VALUES ($1, '1', 'a', 'todo', 0, ''), ($1, 'web:1', 'b', 'todo', 1, 'web')`, [p]);
      await pre.undoLastMigration(); // daily summary part (6.18)
      await pre.undoLastMigration(); // project archive (6.16)
      await pre.undoLastMigration(); // project parts (6.15)
      const cols: unknown[] = await pre.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'project_tasks' AND column_name = 'part'`);
      expect(cols).toHaveLength(0);
      expect(await pre.query(`SELECT task_key FROM project_tasks`)).toEqual([{ task_key: '1' }]);
      await pre.runMigrations();
      expect(await pre.query(`SELECT task_key, part FROM project_tasks`)).toEqual([{ task_key: '1', part: '' }]);
    } finally {
      await pre.destroy();
      await d2.drop();
    }
  });
});
