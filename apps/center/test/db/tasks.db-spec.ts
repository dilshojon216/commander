import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import {
  AGENT_WS_PATH,
  CLIENT_WS_PATH,
  buildAgentAuthString,
  buildClientSubprotocols,
  createEnvelope,
  ListProjectCommitsResponseSchema,
  ListTasksResponseSchema,
  ProjectDetailDtoSchema,
  ProjectTasksResponseSchema,
  SessionDtoSchema,
} from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentIngestService } from '../../src/agent/agent-ingest.service.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

const REAL_TASKS_MD = readFileSync(new URL('../../../../libs/contracts/src/fixtures/commander-TASKS.md', import.meta.url), 'utf8');

/**
 * 2.1/2.2/2.8/2.9 (center tomoni): haqiqiy TimescaleDB + haqiqiy `ws` agent + REST. Snapshot ingest, TASKS.md parse,
 * vazifa span'lari (explicit/branch/tugash) va vazifa bo'yicha token/vaqt agregatsiyasi (realistik hajmda).
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Sock {
  ws: WebSocket;
  nextWhere: (match: (m: Msg) => boolean, ms?: number, label?: string) => Promise<Msg>;
  nextOf: (type: string, ms?: number) => Promise<Msg>;
  send: (m: unknown) => void;
  opened: Promise<void>;
  all: Msg[];
}
interface Agent extends Sock { deviceId: string; machineId: string }

let dbh: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule,
      IdentityModule,
      EventsModule,
      ApprovalsModule,
      LimitsModule,
      ApiModule,
      ProjectsModule,
      AgentModule,
      RealtimeModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 20_000, revokeCheckIntervalMs: 60_000 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  port = (app.getHttpServer().address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await dbh.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openSocket(path: string, protocols?: string[]): Sock {
  const ws = protocols ? new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols) : new WebSocket(`ws://127.0.0.1:${port}${path}`);
  sockets.push(ws);
  const inbox: Msg[] = [];
  const all: Msg[] = [];
  const waiters: Array<{ match: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    all.push(m);
    const idx = waiters.findIndex((w) => w.match(m));
    if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const waitFor = (match: (m: Msg) => boolean, ms: number, label: string): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  return {
    ws,
    all,
    send: (m) => ws.send(JSON.stringify(m)),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    nextOf: (type, ms = 3000) => waitFor((m) => m.type === type, ms, type),
    nextWhere: (match, ms = 3000, label = 'matching message') => waitFor(match, ms, label),
  };
}

async function newAgent(name = 'zz-tasks'): Promise<Agent> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv: KeyObject = privateKey;
  const pubB64 = publicKey.export({ format: 'jwk' }).x as string;
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: pubB64, hardware_id: `hw-t-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const c = openSocket(AGENT_WS_PATH);
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const deviceId = res.body.device_id as string;
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId }), 'utf8'), priv).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0-test', hostname: 'zz-host', os: 'linux' }));
  await c.nextOf('auth.ok');
  return { ...c, deviceId, machineId: res.body.machine_id as string };
}

async function roundtrip(a: Agent, env: ReturnType<typeof createEnvelope>): Promise<Msg> {
  a.send(env);
  return a.nextWhere((m) => (m.type === 'ack' && (m.payload.ids as string[]).includes(env.id)) || (m.type === 'nack' && m.payload.id === env.id), 5000, `ack/nack for ${env.type}`);
}

let reader = '';
beforeAll(async () => {
  const t = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-reader-${randomBytes(2).toString('hex')}`, scopes: ['read'] }, 'test');
  reader = t.token;
});

const ev = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), claudeSessionId: 's-1', event: 'PreToolUse', status: 'working' as 'working', cwd: '/zz/work/commander', ts: Date.now(), ...over,
});

const HASH = (n: number): string => n.toString(16).padStart(64, '0');
const snap = (over: Record<string, unknown> = {}) => ({
  path: '/zz/work/proj-a', name: 'proj-a', kind: 'git', repoKey: 'github.com/org/proj-a', branch: 'main', headSha: 'a'.repeat(40), dirty: false, dirtyCount: 0, ahead: 0, behind: 0,
  commits: [{ sha: 'a'.repeat(40), subject: 'birinchi', author: 'Ali', ts: 1_700_000_000_000 }],
  todosMd: '- bir', changelogMd: '# log', tasksMd: null, tasksPath: null, hash: HASH(1), takenAt: Date.now(), ...over,
});

describe('2.1/2.2: agent.project_snapshot -> projects, project_snapshots, project_tasks', () => {
  let agent: Agent;
  let projectId = '';
  beforeAll(async () => {
    agent = await newAgent('zz-snap');
  });

  it('snapshot ack; loyiha yaratiladi (kind=git, repo_key); commander real TASKS.md parse qilinadi', async () => {
    const r = await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ tasksMd: REAL_TASKS_MD, tasksPath: 'docs/TASKS.md', hash: HASH(1) })));
    expect(r.type).toBe('ack');
    const p = await ds.query(`SELECT id, kind, repo_key, last_snapshot_at FROM projects WHERE path = '/zz/work/proj-a'`);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'git', repo_key: 'github.com/org/proj-a' });
    expect(p[0].last_snapshot_at).not.toBeNull();
    projectId = p[0].id as string;
    const counts = await ds.query(`SELECT status, count(*)::int AS n FROM project_tasks WHERE project_id = $1 GROUP BY status ORDER BY status`, [projectId]);
    const by = Object.fromEntries(counts.map((c: { status: string; n: number }) => [c.status, c.n]));
    expect(by['done']).toBeGreaterThan(20);
    expect(by['todo']).toBeGreaterThan(5);
    const one = await ds.query(`SELECT task_key, status, phase, "order" FROM project_tasks WHERE project_id = $1 AND task_key = '1.4'`, [projectId]);
    expect(one[0]).toMatchObject({ status: 'done' });
    expect(one[0].phase).toMatch(/^Faza 1/);
  });

  it('bir xil xesh qayta: ack, qator ko\'paymaydi; boshqa xesh: yangi qator', async () => {
    expect((await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ tasksMd: REAL_TASKS_MD, tasksPath: 'docs/TASKS.md', hash: HASH(1) })))).type).toBe('ack');
    expect((await ds.query(`SELECT count(*)::int AS n FROM project_snapshots WHERE project_id = $1`, [projectId]))[0].n).toBe(1);
    expect((await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ tasksMd: REAL_TASKS_MD, tasksPath: 'docs/TASKS.md', hash: HASH(2), todosMd: '- ikki', takenAt: Date.now() + 1 })))).type).toBe('ack');
    expect((await ds.query(`SELECT count(*)::int AS n FROM project_snapshots WHERE project_id = $1`, [projectId]))[0].n).toBe(2);
  });

  it('A -> B -> A: mazmun eski holatga qaytsa ham oxirgi snapshot to\'g\'ri', async () => {
    const t = Date.now();
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(10), branch: 'A', tasksMd: '| # | Task |\n|---|---|\n| 1.1 | ✅ a |\n', tasksPath: 'TASKS.md', takenAt: t + 10 })));
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(11), branch: 'B', tasksMd: '| # | Task |\n|---|---|\n| 9.9 | b |\n', tasksPath: 'TASKS.md', takenAt: t + 20 })));
    expect((await ds.query(`SELECT task_key FROM project_tasks WHERE project_id = $1`, [projectId])).map((r: { task_key: string }) => r.task_key)).toEqual(['9.9']);
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(10), branch: 'A', tasksMd: '| # | Task |\n|---|---|\n| 1.1 | ✅ a |\n', tasksPath: 'TASKS.md', takenAt: t + 30 })));
    const detail = ProjectDetailDtoSchema.parse((await http().get(`/v1/projects/${projectId}`).set(bearer(reader)).expect(200)).body);
    expect(detail.git?.branch).toBe('A');
    expect((await ds.query(`SELECT task_key FROM project_tasks WHERE project_id = $1`, [projectId])).map((r: { task_key: string }) => r.task_key)).toEqual(['1.1']);
  });

  it('tartibsiz kelgan ESKI snapshot loyihaning oxirgi holatini buzmaydi', async () => {
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(20), branch: 'eski', takenAt: Date.now() - 3_600_000 })));
    const detail = ProjectDetailDtoSchema.parse((await http().get(`/v1/projects/${projectId}`).set(bearer(reader)).expect(200)).body);
    expect(detail.git?.branch).toBe('A');
  });

  it('tarix: oxirgi 10 ta qoladi, md faqat oxirgi 3 tasida', async () => {
    const base = Date.now() + 1000;
    for (let i = 0; i < 14; i++) await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(100 + i), takenAt: base + i, todosMd: `- t${i}` })));
    const rows = await ds.query(`SELECT todos_md FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC`, [projectId]);
    expect(rows).toHaveLength(10);
    expect(rows.filter((r: { todos_md: string | null }) => r.todos_md !== null)).toHaveLength(3);
    expect(rows[0].todos_md).toBe('- t13');
  });

  it('md markazda ham redakt qilinadi (xavfsizlik to\'ri); ahamiyatsiz yuklama emas', async () => {
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ hash: HASH(300), takenAt: Date.now() + 5000, todosMd: 'API_TOKEN=S3cr3tV4lue99\nghp_abcdefghijklmnopqrstuvwx1234' })));
    const [row] = await ds.query(`SELECT todos_md FROM project_snapshots WHERE project_id = $1 AND hash = $2`, [projectId, HASH(300)]);
    expect(row.todos_md).not.toContain('S3cr3tV4lue99');
    expect(row.todos_md).not.toContain('ghp_abcdef');
  });

  it('yaroqsiz yuklama (xesh/sha/repoKey) nack invalid_payload, DB\'ga tushmaydi', async () => {
    const before = (await ds.query(`SELECT count(*)::int AS n FROM project_snapshots`))[0].n;
    for (const bad of [snap({ hash: 'zz' }), snap({ headSha: 'xyz' }), snap({ repoKey: 'https://user:pw@github.com/x/y' }), snap({ tasksPath: '../../etc/passwd', hash: HASH(400) })]) {
      const r = await roundtrip(agent, createEnvelope('agent.project_snapshot', bad));
      expect(r.type).toBe('nack');
      expect(r.payload).toMatchObject({ code: 'invalid_payload', retriable: false });
    }
    expect((await ds.query(`SELECT count(*)::int AS n FROM project_snapshots`))[0].n).toBe(before);
  });

  it('REST: detail, commits, tasks, /v1/tasks sxemaga mos; 404 va 400', async () => {
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ path: '/zz/work/proj-b', name: 'proj-b', repoKey: null, hash: HASH(500), tasksMd: REAL_TASKS_MD, tasksPath: 'docs/TASKS.md', takenAt: Date.now() + 9000 })));
    const [b] = await ds.query(`SELECT id FROM projects WHERE path = '/zz/work/proj-b'`);
    const detail = ProjectDetailDtoSchema.parse((await http().get(`/v1/projects/${b.id}`).set(bearer(reader)).expect(200)).body);
    expect(detail.project.name).toBe('proj-b');
    expect(detail.git).toMatchObject({ branch: 'main', dirty: false });
    expect(detail.commits).toHaveLength(1);
    expect(detail.todosMd).toBe('- bir');
    expect(detail.tasksMd?.path).toBe('docs/TASKS.md');
    expect(detail.tasksMd?.summary.total).toBeGreaterThanOrEqual(45);
    expect(JSON.stringify(detail)).not.toContain('Faza 2'); // tasksMd matni detail'da qaytmaydi (faqat metadata)

    const commits = ListProjectCommitsResponseSchema.parse((await http().get(`/v1/projects/${b.id}/commits?limit=5`).set(bearer(reader)).expect(200)).body);
    expect(commits.items[0]).toMatchObject({ subject: 'birinchi', author: 'Ali' });

    const tasks = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${b.id}/tasks`).set(bearer(reader)).expect(200)).body);
    expect(tasks.tasks.length).toBeGreaterThanOrEqual(45);
    expect(tasks.tasks.find((t) => t.key === '1.4')).toMatchObject({ status: 'done' });
    expect(tasks.unattributed.label).toBe('vazifasiz');
    const sum = ListTasksResponseSchema.parse((await http().get(`/v1/tasks?project=${b.id}`).set(bearer(reader)).expect(200)).body);
    expect(sum.items).toEqual([]);

    await http().get(`/v1/projects/${randomUUID()}`).set(bearer(reader)).expect(404);
    await http().get(`/v1/projects/${randomUUID()}/tasks`).set(bearer(reader)).expect(404);
    await http().get(`/v1/projects/not-a-uuid`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${b.id}/commits?limit=999`).set(bearer(reader)).expect(400);
    await http().get(`/v1/tasks?bogus=1`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${b.id}`).expect(401);
    await http().get(`/v1/tasks`).expect(401);
  });

  it('/ws/client: `projects` kanalida project.updated (yengil yuklama, md yo\'q)', async () => {
    const c = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(reader));
    await c.opened;
    await c.nextOf('auth.ok');
    c.send(createEnvelope('subscribe', { channels: ['projects'] }));
    await c.nextOf('subscribed');
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap({ path: '/zz/work/proj-c', name: 'proj-c', repoKey: null, hash: HASH(600), tasksMd: '| # | Task |\n|---|---|\n| 1 | ✅ a |\n| 2 | b |\n', tasksPath: 'TASKS.md' })));
    const m = await c.nextWhere((x) => x.type === 'project.updated' && (x.payload.project as { name: string }).name === 'proj-c', 3000, 'project.updated');
    const p = m.payload.project as Record<string, unknown>;
    expect(p).toMatchObject({ branch: 'main', dirty: false, tasks: { total: 2, done: 1, todo: 1, doing: 0, unknown: 0 } });
    expect(JSON.stringify(m.payload)).not.toContain('todosMd');
  });
});

describe('2.9: vazifa span\'lari (marker oqimi)', () => {
  let agent: Agent;
  beforeAll(async () => {
    agent = await newAgent('zz-spans');
  });
  const spans = (sid: string) =>
    ds.query(`SELECT task_key, source, started_at, ended_at FROM session_task_spans WHERE machine_id = $1 AND session_id = $2 ORDER BY started_at, task_key`, [agent.machineId, sid]);
  const T0 = Date.now() - 600_000;

  it('branch -> explicit (branch yopiladi) -> branch (e\'tiborsiz) -> boshqa explicit -> SessionEnd yopadi; takror yuborish dublikat yaratmaydi', async () => {
    const sid = 'sp-1';
    const events = [
      ev({ claudeSessionId: sid, event: 'SessionStart', status: 'idle', ts: T0, taskKey: '1.4', taskSource: 'branch' }),
      ev({ claudeSessionId: sid, event: 'UserPromptSubmit', status: 'working', ts: T0 + 10_000, taskKey: '2.9', taskSource: 'explicit' }),
      ev({ claudeSessionId: sid, event: 'UserPromptSubmit', status: 'working', ts: T0 + 20_000, taskKey: '1.4', taskSource: 'branch' }),
      ev({ claudeSessionId: sid, event: 'UserPromptSubmit', status: 'working', ts: T0 + 30_000, taskKey: '2.1', taskSource: 'explicit' }),
      ev({ claudeSessionId: sid, event: 'SessionEnd', status: 'ended', ts: T0 + 40_000 }),
    ];
    const env = createEnvelope('agent.events', { events });
    expect((await roundtrip(agent, env)).type).toBe('ack');
    const rows = await spans(sid);
    expect(rows.map((r: { task_key: string; source: string }) => [r.task_key, r.source])).toEqual([['1.4', 'branch'], ['2.9', 'explicit'], ['2.1', 'explicit']]);
    const ms = (d: Date | null) => (d ? d.getTime() - T0 : null);
    expect(rows.map((r: { started_at: Date; ended_at: Date | null }) => [ms(r.started_at), ms(r.ended_at)])).toEqual([[0, 10_000], [10_000, 30_000], [30_000, 40_000]]);
    // qayta yuborish (outbox at-least-once): dublikat yo'q
    expect((await roundtrip(agent, createEnvelope('agent.events', { events }))).type).toBe('ack');
    expect(await spans(sid)).toHaveLength(3);
    // bir vaqtda ochiq span yo'q
    expect((await ds.query(`SELECT count(*)::int AS n FROM session_task_spans WHERE ended_at IS NULL AND session_id = $1`, [sid]))[0].n).toBe(0);
  });

  it('branch vazifasiz branchga o\'tsa (taskKey=null, branch) span yopiladi', async () => {
    const sid = 'sp-2';
    await roundtrip(agent, createEnvelope('agent.events', { events: [
      ev({ claudeSessionId: sid, event: 'SessionStart', status: 'idle', ts: T0, taskKey: '3.1', taskSource: 'branch' }),
      ev({ claudeSessionId: sid, event: 'UserPromptSubmit', status: 'working', ts: T0 + 5000, taskKey: null, taskSource: 'branch' }),
    ] }));
    const rows = await spans(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0].ended_at).not.toBeNull();
  });

  it('SessionDto.taskKey: joriy (yoki oxirgi) vazifa', async () => {
    const sid = 'sp-3';
    await roundtrip(agent, createEnvelope('agent.events', { events: [ev({ claudeSessionId: sid, event: 'UserPromptSubmit', status: 'working', ts: T0, taskKey: '2.9', taskSource: 'explicit' })] }));
    const list = (await http().get(`/v1/sessions?machine=${agent.machineId}&limit=50`).set(bearer(reader)).expect(200)).body.items as Array<{ id: string; claudeSessionId: string }>;
    const s = list.find((x) => x.claudeSessionId === sid)!;
    const dto = SessionDtoSchema.parse((await http().get(`/v1/sessions/${s.id}`).set(bearer(reader)).expect(200)).body);
    expect(dto.taskKey).toBe('2.9');
    expect(dto.taskSource).toBe('explicit');
    const none = list.find((x) => x.claudeSessionId === 'sp-1')!;
    expect(SessionDtoSchema.parse((await http().get(`/v1/sessions/${none.id}`).set(bearer(reader)).expect(200)).body).taskKey).toBe('2.1');
    // sessiyada marker yo'q: null
    await roundtrip(agent, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'sp-plain', ts: T0 })] }));
    const plain = (await http().get(`/v1/sessions?machine=${agent.machineId}&limit=50`).set(bearer(reader)).expect(200)).body.items.find((x: { claudeSessionId: string }) => x.claudeSessionId === 'sp-plain');
    expect(plain.taskKey).toBeNull();
  });
});

describe('2.9: vazifa bo\'yicha token/vaqt agregatsiyasi (realistik hajm)', () => {
  const ROWS = 20_000;
  const STEP_S = 10; // so'rovlar orasida 10 s
  let agent: Agent;
  let projectId = '';
  const T0 = Date.now() - 2 * 24 * 3600_000;
  const at = (sec: number): Date => new Date(T0 + sec * 1000);
  // kutilgan yig'indilar (JS'da mustaqil hisoblanadi)
  const expected = new Map<string, { input: number; output: number; req: number }>();
  let expectedUnattr = { input: 0, req: 0 };
  const sessions = ['agg-S1', 'agg-S2', 'agg-S3'] as const;

  const spanFor = (sid: string, sec: number): string | null => {
    if (sid === 'agg-S1') return sec < 1000 ? '1.4' : sec < 2100 ? '2.9' : null; // S1: ikki aniq vazifa (2.9 SessionEnd@2100 da yopiladi), keyin vazifasiz
    if (sid === 'agg-S2') return sec >= 500 ? '1.4' : null; // S2: branch 1.4 (500 s dan keyin)
    return null; // S3: umuman atributsiyasiz
  };

  beforeAll(async () => {
    agent = await newAgent('zz-agg');
    // Hodisalar (haqiqiy yo'l): S1 holatlari va span'lari; S2 branch span; S3 oddiy
    const e = (sid: string, event: string, status: string, sec: number, extra: Record<string, unknown> = {}) => ev({ claudeSessionId: sid, event, status, ts: at(sec).getTime(), cwd: '/zz/work/aggproj', ...extra });
    await roundtrip(agent, createEnvelope('agent.events', { events: [
      e('agg-S1', 'UserPromptSubmit', 'working', 0, { taskKey: '1.4', taskSource: 'explicit' }),
      e('agg-S1', 'Notification', 'waiting', 300),
      e('agg-S1', 'PreToolUse', 'working', 700),
      e('agg-S1', 'UserPromptSubmit', 'working', 1000, { taskKey: '2.9', taskSource: 'explicit' }),
      e('agg-S1', 'Stop', 'done', 1500),
      e('agg-S1', 'UserPromptSubmit', 'working', 1800),
      e('agg-S1', 'SessionEnd', 'ended', 2100),
      e('agg-S2', 'SessionStart', 'idle', 500, { taskKey: '1.4', taskSource: 'branch' }),
      e('agg-S2', 'UserPromptSubmit', 'working', 600),
      e('agg-S2', 'Stop', 'done', 900),
      e('agg-S3', 'UserPromptSubmit', 'working', 0),
    ] }));
    // 1500 ta qo'shimcha hodisa (hajm): marker'siz, holat o'zgarmaydi
    for (let b = 0; b < 15; b++) {
      await svc(AgentIngestService).ingestEvents(agent.machineId, Array.from({ length: 100 }, (_, i) => e('agg-S3', 'PostToolUse', 'working', 10 + b * 100 + i)));
    }
    const [p] = await ds.query(`SELECT id FROM projects WHERE path = '/zz/work/aggproj'`);
    projectId = p.id as string;

    // token_usage: 20k qator, 3 sessiya aylanma, har 10 s
    const recs: Array<{ sid: string; sec: number; input: number; output: number }> = [];
    for (let i = 0; i < ROWS; i++) {
      const sid = sessions[i % 3]!;
      const sec = Math.floor(i / 3) * STEP_S;
      recs.push({ sid, sec, input: (i % 7) + 1, output: (i % 5) + 1 });
    }
    for (const r of recs) {
      const task = spanFor(r.sid, r.sec);
      if (task) {
        const x = expected.get(task) ?? { input: 0, output: 0, req: 0 };
        x.input += r.input; x.output += r.output; x.req += 1;
        expected.set(task, x);
      } else {
        expectedUnattr = { input: expectedUnattr.input + r.input, req: expectedUnattr.req + 1 };
      }
    }
    const CH = 2000;
    for (let i = 0; i < recs.length; i += CH) {
      const part = recs.slice(i, i + CH);
      await ds.query(
        `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
         SELECT timestamptz 'epoch' + u.ts_ms * interval '1 millisecond', $1::uuid, u.rid, u.sid, $2::uuid, 'm', u.inp, u.outp, 0, 0, 0.01, 'otel'
           FROM unnest($3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::bigint[]) AS u(ts_ms, rid, sid, inp, outp)`,
        [agent.machineId, projectId, part.map((r) => at(r.sec).getTime()), part.map((_, j) => `agg-${i + j}`), part.map((r) => r.sid), part.map((r) => r.input), part.map((r) => r.output)],
      );
    }
  }, 120_000);

  it('har vazifa uchun token yig\'indisi, so\'rovlar, sessiyalar JS bilan hisoblanganiga TENG; "vazifasiz" = qolgani', async () => {
    const t = Date.now();
    const res = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body);
    const took = Date.now() - t;
    expect(took).toBeLessThan(3000);
    const byKey = new Map(res.other.map((o) => [o.key, o.stats]));
    for (const [task, exp] of expected) {
      const s = byKey.get(task)!;
      expect(s, task).toBeDefined();
      expect(s.tokens.inputTokens, `${task} input`).toBe(exp.input);
      expect(s.tokens.outputTokens, `${task} output`).toBe(exp.output);
      expect(s.tokens.requests, `${task} requests`).toBe(exp.req);
    }
    expect(byKey.get('1.4')!.sessions).toBe(2); // S1 (explicit) + S2 (branch)
    expect(byKey.get('2.9')!.sessions).toBe(1);
    expect(byKey.get('1.4')!.source).toBe('mixed');
    expect(byKey.get('2.9')!.source).toBe('explicit');
    expect(res.unattributed.label).toBe('vazifasiz');
    expect(res.unattributed.tokens.inputTokens).toBe(expectedUnattr.input);
    expect(res.unattributed.tokens.requests).toBe(expectedUnattr.req);
    // jami = atributsiyalangan + vazifasiz
    const attributed = [...byKey.values()].reduce((a, s) => a + s.tokens.requests, 0);
    expect(attributed + res.unattributed.tokens.requests).toBe(ROWS);
  });

  it('faol vaqt: working oralig\'i span oynasi bilan kesiladi (1.4: 600 s, 2.9: 700 s; S2 branch 1.4: 600..900 = 300 s)', async () => {
    const res = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body);
    const by = new Map(res.other.map((o) => [o.key, o.stats]));
    // 1.4: S1 [0,300)+[700,1000) = 600; S2 (branch, span 500..oxiri) working [600,900) = 300 -> 900
    expect(by.get('1.4')!.activeSeconds).toBe(900);
    // 2.9: span [1000,2100): working [1000,1500)=500 + [1800,2100)=300 -> 800
    expect(by.get('2.9')!.activeSeconds).toBe(800);
  });

  it('/v1/tasks?project=: tartib, loyiha nomi; vaqt oralig\'i filtri; repo/machine filtrlari; yo\'q loyiha bo\'sh', async () => {
    const all = ListTasksResponseSchema.parse((await http().get(`/v1/tasks?project=aggproj`).set(bearer(reader)).expect(200)).body);
    expect(all.items.map((i) => i.taskKey).sort()).toEqual(['1.4', '2.9']);
    expect(all.items[0]!.projectName).toBe('aggproj');
    expect(all.items[0]!.stats.tokens.totalTokens).toBeGreaterThanOrEqual(all.items[1]!.stats.tokens.totalTokens);
    // vaqt oralig'i: faqat [0, 500) soniya -> 1.4 faqat S1'dan
    const from = at(0).toISOString();
    const to = at(500).toISOString();
    const ranged = ListTasksResponseSchema.parse((await http().get(`/v1/tasks?project=${projectId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).set(bearer(reader)).expect(200)).body);
    const k = ranged.items.find((i) => i.taskKey === '1.4')!;
    expect(k.stats.tokens.requests).toBeGreaterThan(0);
    expect(k.stats.tokens.requests).toBeLessThan(expected.get('1.4')!.req);
    expect(ranged.items.find((i) => i.taskKey === '2.9')).toBeUndefined();
    const byMachine = ListTasksResponseSchema.parse((await http().get(`/v1/tasks?machine=${agent.machineId}`).set(bearer(reader)).expect(200)).body);
    expect(byMachine.items.length).toBeGreaterThanOrEqual(2);
    const none = ListTasksResponseSchema.parse((await http().get(`/v1/tasks?project=${randomUUID()}`).set(bearer(reader)).expect(200)).body);
    expect(none.items).toEqual([]);
    expect(none.unattributed.tokens.requests).toBe(0);
  });

  it('EXPLAIN: span -> token_usage qo\'shilishi idx_token_usage_session_ts indeksidan foydalanadi (ketma-ket skanerlash emas)', async () => {
    const plan: Array<{ 'QUERY PLAN': string }> = await ds.query(
      `EXPLAIN SELECT sp.task_key, sum(tu.input_tokens) FROM session_task_spans sp
         JOIN token_usage tu ON tu.machine_id = sp.machine_id AND tu.session_id = sp.session_id AND tu.ts >= sp.started_at AND tu.ts < COALESCE(sp.ended_at, 'infinity')
        WHERE sp.project_id = $1 GROUP BY 1`,
      [projectId],
    );
    const text = plan.map((p) => p['QUERY PLAN']).join('\n');
    expect(text).toMatch(/idx_token_usage_session_ts|idx_token_usage_project_ts|Index/);
  });
});
