import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ListProjectsResponseSchema, ProjectArchiveResponseSchema } from '@commander/contracts';
import { AgentIngestService } from '../../src/agent/agent-ingest.service.js';
import { UsageService } from '../../src/api/usage.service.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsService } from '../../src/events/events.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { ProjectArchiveService } from '../../src/projects/project-archive.service.js';
import { ProjectPartsService } from '../../src/projects/project-parts.service.js';
import { ProjectArchiveController } from '../../src/projects/projects.controller.js';
import { TaskSpansService } from '../../src/projects/task-spans.service.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb, pausePolicyJobs } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 6.16 Loyihani arxivlash: ro'yxatdan yashirish (ma'lumot o'chmaydi), jami hisobga kiradi, yangi sessiya avtomatik qaytaradi,
 * REST: control scope + audit, lockdown to'smaydi.
 */
type Ev = Parameters<AgentIngestService['ingestEvents']>[1][number];
let seq = 0;
const ev = (o: Record<string, unknown>): Ev =>
  ({ eventId: randomUUID(), event: 'PreToolUse', status: 'working', ts: Date.now() - 60_000 + seq++ * 1000, ...o }) as unknown as Ev;

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let usage: UsageService;
let archive: ProjectArchiveService;
let ing: AgentIngestService;

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-hook-secret' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      IdentityModule,
    ],
    controllers: [ProjectArchiveController],
    providers: [ProjectArchiveService],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.init();
  ds = app.get(DataSource);
  // Yangi bazada retention/cagg job'lari FK qulflari bilan deadlock beradi (test artefakti): to'xtatiladi.
  await pausePolicyJobs(ds);
  usage = new UsageService(ds, new ConfigService({ STALE_MINUTES: 720 }));
  archive = app.get(ProjectArchiveService);
  const parts = new ProjectPartsService(ds);
  ing = new AgentIngestService(ds, new EventsService(ds), new RealtimeBus(), new TaskSpansService(parts), parts);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function machine(): Promise<string> {
  const rows: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ($1) RETURNING id`, [`m-${randomUUID().slice(0, 8)}`]);
  return rows[0]!.id;
}
async function project(m: string, path: string): Promise<string> {
  const rows: Array<{ id: string }> = await ds.query(`SELECT upsert_project($1::uuid, $2, NULL, NULL, 'dir') AS id`, [m, path]);
  return rows[0]!.id;
}
/** Bugungi token (cagg'ga tushishi uchun to'g'ridan-to'g'ri token_usage; cagg real-time). */
async function tokens(m: string, p: string, n: number): Promise<void> {
  await ds.query(
    `INSERT INTO token_usage (ts, machine_id, request_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source)
     VALUES (now(), $1, $2, $3, 'm', $4, 0, 0, 0, 'otel')`,
    [m, randomUUID(), p, n],
  );
}
const listed = async (opts: { archived?: '1' | '0'; machine?: string } = {}) => usage.projects({ limit: 200, archived: opts.archived, machine: opts.machine });

describe('arxivlash va ro\'yxatlar', () => {
  it('archive/unarchive: idempotent, asl vaqt saqlanadi, noma\'lum id = 404', async () => {
    const m = await machine();
    const p = await project(m, '/junk/a');
    const first = await archive.setArchived(p, true);
    expect(first.archivedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 15));
    expect((await archive.setArchived(p, true)).archivedAt).toBe(first.archivedAt);
    expect((await archive.setArchived(p, false)).archivedAt).toBeNull();
    expect((await archive.setArchived(p, false)).archivedAt).toBeNull();
    await expect(archive.setArchived(randomUUID(), true)).rejects.toMatchObject({ status: 404 });
  });

  it('GET /projects: default faqat faollar, ?archived=1 faqat arxivlanganlar, detail arxivlangan loyihada ham ishlaydi; tarix o\'chmaydi', async () => {
    const m = await machine();
    const keep = await project(m, '/work/keep');
    const junk = await project(m, '/junk/b');
    await tokens(m, keep, 100);
    await tokens(m, junk, 40);
    await ds.query(
      `INSERT INTO sessions (machine_id, claude_session_id, cwd, project, status, started_at, status_since, last_seen_at, project_id) VALUES ($1, 's-junk', '/junk/b', 'b', 'idle', now(), now(), now(), $2)`,
      [m, junk],
    );
    await archive.setArchived(junk, true);

    const active = await listed({ machine: m });
    expect(active.items.map((p) => p.id)).toEqual([keep]);
    expect(active.items[0]!.archivedAt).toBeNull();
    const arch = await listed({ archived: '1', machine: m });
    expect(arch.items.map((p) => p.id)).toEqual([junk]);
    expect(arch.items[0]!.archivedAt).not.toBeNull();
    expect(arch.items[0]!.allTime.totalTokens).toBe(40);

    // Jami hisobga kiradi: arxiv yig'indisi alohida qaytadi (ro'yxatda yo'q)
    expect(active.archived.count).toBe(1);
    expect(active.archived.today.totalTokens).toBe(40);
    expect(active.archived.allTime.totalTokens).toBe(40);
    expect(active.archived.todayByMachine).toEqual([{ machineId: m, totalTokens: 40 }]);
    expect(ListProjectsResponseSchema.safeParse(JSON.parse(JSON.stringify(active))).success).toBe(true);

    const one = await usage.projectById(junk);
    expect(one?.archivedAt).not.toBeNull();
    expect((await ds.query(`SELECT count(*)::int AS n FROM sessions WHERE project_id = $1`, [junk]))[0].n).toBe(1);
    expect((await ds.query(`SELECT count(*)::int AS n FROM token_usage WHERE project_id = $1`, [junk]))[0].n).toBe(1);
    const summary = await usage.summary();
    expect(summary.allTime.totals.totalTokens).toBeGreaterThanOrEqual(140);
  });
});

describe('avto-qaytarish: yangi sessiya', () => {
  it('arxivlangan loyihada YANGI sessiya boshlansa archived_at tozalanadi; mavjud sessiya hodisasi tozalamaydi', async () => {
    const m = await machine();
    const cwd = `/junk/${randomUUID().slice(0, 6)}`;
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'old', cwd, rootKind: 'dir', event: 'SessionStart', status: 'idle' })]);
    const [{ id }]: Array<{ id: string }> = await ds.query(`SELECT id FROM projects WHERE machine_id = $1 AND path = $2`, [m, cwd]);
    await archive.setArchived(id!, true);

    // Mavjud sessiyada yangi hodisa: hali arxivda
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'old', cwd, rootKind: 'dir' })]);
    expect((await usage.projectById(id!))?.archivedAt).not.toBeNull();

    // Boshqa loyihaning yangi sessiyasi tegmaydi
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'other', cwd: `${cwd}-x`, rootKind: 'dir', event: 'SessionStart', status: 'idle' })]);
    expect((await usage.projectById(id!))?.archivedAt).not.toBeNull();

    // Shu loyihada YANGI sessiya (birinchi hodisa)
    await ing.ingestEvents(m, [ev({ claudeSessionId: 'fresh', cwd, rootKind: 'dir', event: 'SessionStart', status: 'idle' })]);
    expect((await usage.projectById(id!))?.archivedAt).toBeNull();
    expect((await listed({ machine: m })).items.map((p) => p.id)).toContain(id);
  });
});

describe('Telegram /p', () => {
  it('qismlar ko\'rinishi arxivlangan loyihani chiqarmaydi', async () => {
    const m = await machine();
    const name = `zz-arch-${randomUUID().slice(0, 6)}`;
    const live = await project(m, `/w/${name}-live`);
    const junk = await project(m, `/w/${name}-junk`);
    for (const id of [live, junk]) await ds.query(`INSERT INTO project_parts (project_id, part, name, done, total) VALUES ($1, 'api', 'api', 1, 2)`, [id]);
    const parts = new ProjectPartsService(ds);
    expect((await parts.overview(name)).map((p) => p.id).sort()).toEqual([live, junk].sort());
    await archive.setArchived(junk, true);
    expect((await parts.overview(name)).map((p) => p.id)).toEqual([live]);
  });
});

describe('REST: control scope, audit, lockdown', () => {
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const issue = (scopes: string[]) => app.get(ClientTokensService).issue({ kind: 'web', name: 'zz-test-6.16', scopes }, 'test');

  it('control: 200 + audit (project.archived/unarchived, target=id); read token 403; lockdown to\'smaydi', async () => {
    const m = await machine();
    const p = await project(m, `/junk/${randomUUID().slice(0, 6)}`);
    const ctl = await issue(['control']);
    const reader = await issue(['read']);
    const http = app.getHttpServer();

    await request(http).post(`/v1/projects/${p}/archive`).set(bearer(reader.token)).expect(403);
    await request(http).post(`/v1/projects/${p}/archive`).expect(401);
    await request(http).post('/v1/projects/not-a-uuid/archive').set(bearer(ctl.token)).expect(400);
    await request(http).post(`/v1/projects/${randomUUID()}/archive`).set(bearer(ctl.token)).expect(404);

    const a = await request(http).post(`/v1/projects/${p}/archive`).set(bearer(ctl.token)).expect(200);
    expect(ProjectArchiveResponseSchema.parse(a.body)).toMatchObject({ id: p });
    expect(a.body.archivedAt).not.toBeNull();

    await app.get(LockdownService).set(true, 'test');
    try {
      const u = await request(http).post(`/v1/projects/${p}/unarchive`).set(bearer(ctl.token)).expect(200);
      expect(u.body.archivedAt).toBeNull();
      await request(http).post(`/v1/projects/${p}/archive`).set(bearer(ctl.token)).expect(200);
    } finally {
      await app.get(LockdownService).set(false, 'test');
    }

    const rows: Array<{ action: string; target: string }> = await ds.query(`SELECT action, target FROM audit_log WHERE target = $1 AND action LIKE 'project.%' ORDER BY id`, [p]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['project.archived', 'project.unarchived']));
    expect(rows.filter((r) => r.action === 'project.archived').length).toBeGreaterThanOrEqual(2);
  });
});
