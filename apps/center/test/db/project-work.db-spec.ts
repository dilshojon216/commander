import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
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
  DailyResponseSchema,
  MdExtractResponseSchema,
  MdFilesResponseSchema,
  PatchBoardResponseSchema,
  ProjectCommandResponseSchema,
  ProjectTasksResponseSchema,
  buildAgentAuthString,
  createEnvelope,
} from '@commander/contracts';
import type { CommandDto } from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import type { CommandActor } from '../../src/commands/commands.service.js';
import { StepUpRegistry } from '../../src/commands/step-up.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 2.15 (center tomoni): doska overlay + task_events, kunlik agregatsiya (Asia/Tashkent chegaralari), md-files/md-extract,
 * append/refresh/summarize buyruqlari (soxta agent, haqiqiy imzolangan dispatch), step-up istisnosi. Haqiqiy TimescaleDB + `ws`.
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Sock {
  ws: WebSocket;
  all: Msg[];
  send: (m: unknown) => void;
  nextWhere: (match: (m: Msg) => boolean, ms?: number, label?: string) => Promise<Msg>;
  nextOf: (type: string, ms?: number) => Promise<Msg>;
  expectNone: (type: string, ms?: number) => Promise<void>;
  opened: Promise<void>;
}
interface Agent extends Sock { deviceId: string; machineId: string }

let dbh: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
const sockets: WebSocket[] = [];
const stepUpRequests: CommandDto[] = [];

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, ProjectsModule, AgentModule, RealtimeModule, CommandsModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 30_000, revokeCheckIntervalMs: 60_000 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  port = (app.getHttpServer().address() as AddressInfo).port;
  app.get(StepUpRegistry).register({
    isAvailable: async () => true,
    request: async (c) => {
      stepUpRequests.push(c);
      return 1;
    },
  });
}, 120_000);
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await dbh.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

function openSocket(path: string): Sock {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
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
    ws, all,
    send: (m) => ws.send(JSON.stringify(m)),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    nextOf: (type, ms = 3000) => waitFor((m) => m.type === type, ms, type),
    nextWhere: (match, ms = 3000, label = 'matching message') => waitFor(match, ms, label),
    expectNone: async (type, ms = 300) => {
      const start = all.length;
      await sleep(ms);
      expect(all.slice(start).filter((m) => m.type === type)).toHaveLength(0);
    },
  };
}

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, projectOps: true, allowProjectRead: true, allowProjectWrite: true };
const CONTROL_OLD = { ...CONTROL_ON, projectOps: undefined };

async function newAgent(name: string, control: Record<string, unknown> = CONTROL_ON): Promise<Agent> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv: KeyObject = privateKey;
  const pubB64 = publicKey.export({ format: 'jwk' }).x as string;
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: pubB64, hardware_id: `hw-pw-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const c = openSocket(AGENT_WS_PATH);
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const deviceId = res.body.device_id as string;
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId }), 'utf8'), priv).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0-test', hostname: 'zz-host', os: 'linux' }));
  await c.nextOf('auth.ok');
  const machineId = res.body.machine_id as string;
  c.send(createEnvelope('agent.heartbeat', { control }));
  await eventually(async () => (await ds.query(`SELECT control FROM machines WHERE id = $1`, [machineId]))[0].control, (v) => v !== null);
  return { ...c, deviceId, machineId };
}

async function roundtrip(a: Agent, env: ReturnType<typeof createEnvelope>): Promise<Msg> {
  a.send(env);
  return a.nextWhere((m) => (m.type === 'ack' && (m.payload.ids as string[]).includes(env.id)) || (m.type === 'nack' && m.payload.id === env.id), 5000, `ack/nack for ${env.type}`);
}

const issue = async (scopes: string[], kind: 'web' | 'telegram' = 'web'): Promise<{ id: string; token: string }> => {
  const t = await svc(ClientTokensService).issue({ kind, name: `zz-pw-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
};

const HASH = (n: number): string => n.toString(16).padStart(64, '0');
const T = (s: string): number => Date.parse(s);
const ev = (sid: string, event: string, status: string, ts: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), claudeSessionId: sid, event, status, cwd, ts: T(ts), ...extra,
});
const TASKS_MD = (statuses: Record<string, string>): string =>
  `# T\n\n## Faza 1 — Test\n\n| # | Task | Hajm |\n|---|---|---|\n${['1.1', '1.2', '1.3'].map((k) => `| ${k} | ${statuses[k] ?? ''} Vazifa ${k} | ${k === '1.1' ? 'M' : k === '1.2' ? '3h' : 'L'} |`).join('\n')}\n`;
const snap = (path: string, over: Record<string, unknown> = {}) => ({
  path, name: path.split('/').pop(), kind: 'git', repoKey: null, branch: 'main', headSha: 'a'.repeat(40), dirty: false, dirtyCount: 0, ahead: 0, behind: 0,
  commits: [], todosMd: null, changelogMd: null, tasksMd: null, tasksPath: null, hash: HASH(1), takenAt: Date.now(), ...over,
});
const actorOf = (deviceId: string): CommandActor => ({ deviceId, actorKind: 'telegram', ip: null });

// ---------------------------------------------------------------------------------------------

describe('doska (overlay), task_events, kunlik agregatsiya (Asia/Tashkent)', () => {
  let agent: Agent;
  let projectId = '';
  let ctl: { id: string; token: string };
  let reader = '';
  const PATH = '/zz/work/dailyproj';

  beforeAll(async () => {
    agent = await newAgent('zz-daily');
    ctl = await issue(['read', 'control']);
    reader = (await issue(['read'])).token;

    // 1) birinchi snapshot: hammasi todo (task_events yozilmaydi)
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, { hash: HASH(1), takenAt: T('2026-11-05T05:00:00Z'), tasksMd: TASKS_MD({}), tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(777), mdFiles: ['README.md', 'docs/spec.md'] })));
    const [p] = await ds.query(`SELECT id FROM projects WHERE path = $1`, [PATH]);
    projectId = p.id as string;
    // 2) 1.1 done (11-05 kunida), 3) 1.2 done (Tashkent 11-06 00:30)
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, { hash: HASH(2), takenAt: T('2026-11-05T12:00:00Z'), tasksMd: TASKS_MD({ '1.1': '✅' }), tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(778), mdFiles: ['README.md', 'docs/spec.md'], commits: [{ sha: 'b'.repeat(40), subject: 'feat: doska token=sk-ant-abcdefghijklmnop', author: 'Ali', ts: T('2026-11-05T11:00:00Z') }] })));
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, { hash: HASH(3), takenAt: T('2026-11-05T19:30:00Z'), tasksMd: TASKS_MD({ '1.1': '✅', '1.2': '✅' }), tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(779), mdFiles: ['README.md', 'docs/spec.md'], commits: [{ sha: 'b'.repeat(40), subject: 'feat: doska token=sk-ant-abcdefghijklmnop', author: 'Ali', ts: T('2026-11-05T11:00:00Z') }] })));

    // Sessiya hodisalari: Tashkent yarim kechasi (19:00Z) bo'ylab
    const SID = 'dl-S1';
    await roundtrip(agent, createEnvelope('agent.events', { events: [
      ev(SID, 'UserPromptSubmit', 'working', '2026-11-04T18:50:00Z', PATH, { taskKey: '1.1', taskSource: 'explicit' }),
      ev(SID, 'Stop', 'done', '2026-11-04T19:10:00Z', PATH),
      ev(SID, 'UserPromptSubmit', 'working', '2026-11-05T10:00:00Z', PATH, { taskKey: '1.2', taskSource: 'explicit' }),
      ev(SID, 'Stop', 'done', '2026-11-05T10:30:00Z', PATH),
      ev(SID, 'UserPromptSubmit', 'working', '2026-11-05T18:50:00Z', PATH),
      ev(SID, 'SessionEnd', 'ended', '2026-11-05T19:10:00Z', PATH),
    ] }));
    // Tokenlar: har biri boshqa kun/vazifa oynasiga tushadi
    const tok = [
      ['2026-11-04T18:55:00Z', 'a1', 10], // 11-04, 1.1
      ['2026-11-04T19:05:00Z', 'a2', 20], // 11-05, 1.1 (span 1.1 hali ochiq)
      ['2026-11-05T10:15:00Z', 'a3', 40], // 11-05, 1.2
      ['2026-11-05T19:05:00Z', 'a4', 80], // 11-06, 1.2 (span 19:10 gacha)
      ['2026-11-05T20:00:00Z', 'a5', 160], // 11-06, vazifasiz (span yopilgan)
    ] as const;
    for (const [ts, rid, n] of tok) {
      await ds.query(
        `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
         VALUES ($1, $2, $3, $4, $5, 'm', $6, 0, 0, 0, 0.01, 'otel')`,
        [ts, agent.machineId, rid, SID, projectId, n],
      );
    }
  }, 60_000);

  it('task_events: birinchi snapshot hodisa yozmaydi; keyingilari faqat o\'zgargan holatlarni (tasks_md manbasi, snapshot vaqti bilan)', async () => {
    const rows = await ds.query(`SELECT task_key, from_status, to_status, source, ts FROM task_events WHERE project_id = $1 ORDER BY ts`, [projectId]);
    expect(rows.map((r: { task_key: string; from_status: string; to_status: string; source: string }) => [r.task_key, r.from_status, r.to_status, r.source])).toEqual([
      ['1.1', 'todo', 'done', 'tasks_md'],
      ['1.2', 'todo', 'done', 'tasks_md'],
    ]);
    expect(rows[0].ts.toISOString()).toBe('2026-11-05T12:00:00.000Z');
    // Qayta yuborish (outbox at-least-once) yangi hodisa yaratmaydi
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, { hash: HASH(3), takenAt: T('2026-11-05T19:30:00Z'), tasksMd: TASKS_MD({ '1.1': '✅', '1.2': '✅' }), tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(779), mdFiles: ['README.md', 'docs/spec.md'] })));
    expect((await ds.query(`SELECT count(*)::int AS n FROM task_events WHERE project_id = $1`, [projectId]))[0].n).toBe(2);
  });

  it('GET daily: Toshkent kunlari chegarasida faol vaqt/token/sessiya to\'g\'ri bo\'linadi', async () => {
    const res = DailyResponseSchema.parse((await http().get(`/v1/projects/${projectId}/daily?from=2026-11-04&to=2026-11-06`).set(bearer(reader)).expect(200)).body);
    expect(res.timezone).toBe('Asia/Tashkent');
    expect(res.days.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    const [d04, d05, d06] = res.days as [typeof res.days[number], typeof res.days[number], typeof res.days[number]];
    const t = (d: typeof d04, k: string) => d.tasks.find((x) => x.taskKey === k);

    // 11-04: 1.1 [18:50, 19:00) = 600 s; token a1 (10)
    expect(d04.tasks.map((x) => x.taskKey)).toEqual(['1.1']);
    expect(t(d04, '1.1')).toMatchObject({ activeSeconds: 600, sessions: 1, title: 'Vazifa 1.1' });
    expect(t(d04, '1.1')!.tokens.inputTokens).toBe(10);
    expect(t(d04, '1.1')!.firstActivityAt).toBe('2026-11-04T18:55:00.000Z');
    expect(d04.totals).toMatchObject({ tasksWorked: 1, tasksDone: 0, activeSeconds: 600, sessions: 1 });

    // 11-05: 1.1 [19:00,19:10) = 600 s (token a2=20); 1.2: 30 min + [18:50,19:00) 10 min = 2400 s (a3=40)
    expect(d05.tasks.map((x) => x.taskKey).sort()).toEqual(['1.1', '1.2']);
    expect(t(d05, '1.1')).toMatchObject({ activeSeconds: 600 });
    expect(t(d05, '1.1')!.tokens.inputTokens).toBe(20);
    expect(t(d05, '1.2')).toMatchObject({ activeSeconds: 2400 });
    expect(t(d05, '1.2')!.tokens.inputTokens).toBe(40);
    // kun oynasi bilan kesilgan birinchi faollik: 11-05 boshi 19:00Z (11-04) dan oldin bo'lmaydi
    for (const x of d05.tasks) expect(Date.parse(x.firstActivityAt)).toBeGreaterThanOrEqual(T('2026-11-04T19:00:00Z'));
    // reja vs haqiqiy: 1.2 hajmi "3h" (aniq), 2400 s = 0.7 soat
    expect(t(d05, '1.2')!.plan).toMatchObject({ estimateHours: 3, estimateSource: 'explicit', actualHours: 0.7 });
    expect(d05.totals).toMatchObject({ tasksWorked: 2, activeSeconds: 3000, sessions: 1 });
    expect(d05.totals.totalTokens).toBe(60);
    // bajarilgan: 1.1 (snapshot 12:00Z = 11-05)
    expect(d05.doneTasks.map((x) => [x.taskKey, x.source])).toEqual([['1.1', 'tasks_md']]);
    expect(d05.totals.tasksDone).toBe(1);

    // 11-06: 1.2 [19:00,19:10) = 600 s (a4=80); vazifasiz token 160; done: 1.2 (snapshot 19:30Z = 00:30 Toshkent)
    expect(d06.tasks.map((x) => x.taskKey)).toEqual(['1.2']);
    expect(t(d06, '1.2')).toMatchObject({ activeSeconds: 600 });
    expect(t(d06, '1.2')!.tokens.inputTokens).toBe(80);
    expect(d06.totals.unattributedTokens).toBe(160);
    expect(d06.doneTasks.map((x) => x.taskKey)).toEqual(['1.2']);
  });

  it('default = bugun (bo\'sh kun ham bor); yaroqsiz/katta oraliq 400; yo\'q loyiha 404; tokensiz 401; kelajak kuni bo\'sh', async () => {
    const today = DailyResponseSchema.parse((await http().get(`/v1/projects/${projectId}/daily`).set(bearer(reader)).expect(200)).body);
    expect(today.days).toHaveLength(1);
    expect(today.days[0]!.date).toBe(new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10));
    expect(today.days[0]!.tasks).toEqual([]);
    await http().get(`/v1/projects/${projectId}/daily?from=2026-13-40`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${projectId}/daily?from=2026-11-06&to=2026-11-05`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${projectId}/daily?from=2026-01-01&to=2026-12-31`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${projectId}/daily?bogus=1`).set(bearer(reader)).expect(400);
    await http().get(`/v1/projects/${randomUUID()}/daily`).set(bearer(reader)).expect(404);
    await http().get(`/v1/projects/${projectId}/daily`).expect(401);
    const future = DailyResponseSchema.parse((await http().get(`/v1/projects/${projectId}/daily?from=2099-01-01&to=2099-01-01`).set(bearer(reader)).expect(200)).body);
    expect(future.days[0]!.tasks).toEqual([]);
  });

  it('doska: samarali ustun (TASKS.md done ustun; overlay; hisoblangan) va PATCH (scope control, audit, task_events, project.changed)', async () => {
    const tasks = async () => ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body).tasks;
    const col = async (k: string) => (await tasks()).find((x) => x.key === k)!;
    expect(await col('1.1')).toMatchObject({ column: 'done', columnSource: 'tasks_md', plan: { estimateHours: 6, estimateSource: 'size' } });
    expect(await col('1.3')).toMatchObject({ column: 'todo', columnSource: 'derived', plan: { estimateHours: 16 } }); // L = 16 (default)

    // scope: read 403, tokensiz 401
    await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(reader)).send({ column: 'review' }).expect(403);
    await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).send({ column: 'review' }).expect(401);
    // validatsiya
    await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'archived' }).expect(400);
    await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'doing', extra: 1 }).expect(400);
    await http().patch(`/v1/projects/${projectId}/tasks/9.9/board`).set(bearer(ctl.token)).send({ column: 'doing' }).expect(404);
    await http().patch(`/v1/projects/${randomUUID()}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'doing' }).expect(404);

    const r = PatchBoardResponseSchema.parse((await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'review' }).expect(200)).body);
    expect(r).toMatchObject({ column: 'review', columnSource: 'board', changed: true });
    expect(await col('1.3')).toMatchObject({ column: 'review', columnSource: 'board' });
    // bir xil ustunga qayta surish: changed=false, task_events qo'shilmaydi
    expect(PatchBoardResponseSchema.parse((await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'review' }).expect(200)).body).changed).toBe(false);
    // TASKS.md done vazifa surilmaydi
    expect(PatchBoardResponseSchema.parse((await http().patch(`/v1/projects/${projectId}/tasks/1.1/board`).set(bearer(ctl.token)).send({ column: 'todo' }).expect(200)).body)).toMatchObject({ column: 'done', columnSource: 'tasks_md', changed: false });
    expect((await ds.query(`SELECT count(*)::int AS n FROM task_board WHERE project_id = $1 AND task_key = '1.1'`, [projectId]))[0].n).toBe(0);

    const events = await ds.query(`SELECT task_key, from_status, to_status, source FROM task_events WHERE project_id = $1 AND source = 'board'`, [projectId]);
    expect(events).toEqual([{ task_key: '1.3', from_status: 'todo', to_status: 'review', source: 'board' }]);
    const audit = (await ds.query(`SELECT action, details FROM audit_log WHERE action LIKE 'task.board.%' ORDER BY id`)) as Array<{ action: string; details: Record<string, unknown> }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['task.board.set', 'task.board.refused']));

    // doskada "done"ga surish: kunlik "bajarilgan"da (board manbasi) ko'rinadi
    await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'done' }).expect(200);
    const today = DailyResponseSchema.parse((await http().get(`/v1/projects/${projectId}/daily`).set(bearer(reader)).expect(200)).body);
    expect(today.days[0]!.doneTasks.map((d) => [d.taskKey, d.source])).toEqual([['1.3', 'board']]);

    // lockdown: control route 403 (guard), o'qish ishlaydi
    await svc(LockdownService).set(true, 'test');
    try {
      await http().patch(`/v1/projects/${projectId}/tasks/1.3/board`).set(bearer(ctl.token)).send({ column: 'todo' }).expect(403);
      await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });

  it('tasks.size_hours sozlamasi default xaritani almashtiradi; yaroqsiz sozlama = default', async () => {
    await ds.query(`INSERT INTO settings (key, value) VALUES ('tasks.size_hours', '{"M": 10, "XL": 80}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const t1 = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body).tasks;
    expect(t1.find((x) => x.key === '1.1')!.plan.estimateHours).toBe(10);
    expect(t1.find((x) => x.key === '1.3')!.plan.estimateHours).toBe(16); // L default qoldi
    await ds.query(`UPDATE settings SET value = '"yaroqsiz"'::jsonb WHERE key = 'tasks.size_hours'`);
    const t2 = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body).tasks;
    expect(t2.find((x) => x.key === '1.1')!.plan.estimateHours).toBe(6);
    await ds.query(`DELETE FROM settings WHERE key = 'tasks.size_hours'`);
  });

  // --- buyruqlar (soxta agent) ----------------------------------------------------------------

  async function agentRun(a: Agent, commandId: string, finish: { state: 'done' | 'failed'; result?: unknown; error?: { code: string; message: string } }): Promise<void> {
    a.send(createEnvelope('command.ack', { commandId }));
    await eventually(async () => (await ds.query(`SELECT status FROM commands WHERE id = $1`, [commandId]))[0].status, (s) => s === 'acked');
    const env = createEnvelope('command.result', { commandId, ...finish });
    a.send(env);
    await a.nextWhere((m) => m.type === 'ack' && (m.payload.ids as string[]).includes(env.id));
  }

  it('md-files: snapshot\'dagi ro\'yxat; eski agentd (null) -> bo\'sh', async () => {
    const r = MdFilesResponseSchema.parse((await http().get(`/v1/projects/${projectId}/md-files`).set(bearer(reader)).expect(200)).body);
    expect(r.files).toEqual(['README.md', 'docs/spec.md']);
    expect(r.takenAt).not.toBeNull();
    await http().get(`/v1/projects/${randomUUID()}/md-files`).set(bearer(reader)).expect(404);
  });

  it('md-extract: faqat ro\'yxatdagi fayl; imzolangan project.read_md; md DB\'ga YOZILMAYDI; nomzodlar + keyingi id\'lar', async () => {
    await http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(reader)).send({ path: 'docs/spec.md' }).expect(403);
    await http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(ctl.token)).send({ path: 'docs/yoq.md' }).expect(404);
    for (const bad of ['../etc/x.md', '/etc/a.md', 'a.txt']) await http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(ctl.token)).send({ path: bad }).expect(400);

    const MD = '# Spec\n\n## Auth\n- [ ] Login ekrani\n- [ ] Parol tiklash\n\n## Vazifa 1.2 takrori\nIzoh.\n\n## Hisobot sahifasi\nHisobot.\n';
    const pending = http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(ctl.token)).send({ path: 'docs/spec.md' }).then((r) => r);
    const d = await agent.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'project.read_md', payload: { root: PATH, path: 'docs/spec.md' } });
    await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { md: { path: 'docs/spec.md', content: MD, bytes: MD.length, truncated: false } } });
    const res = await pending;
    expect(res.status).toBe(200);
    const out = MdExtractResponseSchema.parse(res.body);
    expect(out).toMatchObject({ path: 'docs/spec.md', truncated: false, phases: ['Faza 1 — Test'], suggestedPhase: 'Faza 1 — Test' });
    expect(out.candidates.map((c) => c.title)).toEqual(['Login ekrani', 'Parol tiklash', 'Vazifa 1.2 takrori', 'Hisobot sahifasi']);
    // Faza 1 da 1.1-1.3 bor: keyingilar 1.4, 1.5, 1.6
    expect(out.candidates.map((c) => c.suggestedKey)).toEqual(['1.4', '1.5', '1.6', '1.7']);
    // md matni DB'ga tushmaydi
    const [row] = await ds.query(`SELECT payload::text AS p, result::text AS r, status FROM commands WHERE id = $1`, [d.payload.commandId]);
    expect(row.status).toBe('done');
    expect(`${row.p}${row.r}`).not.toContain('Login ekrani');
    const audit = await ds.query(`SELECT action FROM audit_log WHERE target = $1`, [d.payload.commandId]);
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['command.created', 'command.dispatched', 'command.result']));
  });

  it('md-extract: agent xato qaytarsa HTTP xato (md yo\'q), buyruq failed', async () => {
    const pending = http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(ctl.token)).send({ path: 'README.md' }).then((r) => r);
    const d = await agent.nextOf('command.dispatch');
    await agentRun(agent, d.payload.commandId as string, { state: 'failed', error: { code: 'file_not_found', message: 'yo\'q' } });
    const res = await pending;
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'file_not_found' });
  });

  it('refresh: project.refresh dispatch (step-up yo\'q, read-only), natija command.updated', async () => {
    const res = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/refresh`).set(bearer(ctl.token)).expect(201)).body);
    expect(res.command).toMatchObject({ type: 'project.refresh', status: 'sent', projectId, stepUp: { required: false } });
    const d = await agent.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'project.refresh', payload: { root: PATH } });
    await agentRun(agent, res.command.id, { state: 'done', result: { detail: 'snapshot queued' } });
    expect((await ds.query(`SELECT status FROM commands WHERE id = $1`, [res.command.id]))[0].status).toBe('done');
    await http().post(`/v1/projects/${projectId}/refresh`).set(bearer(reader)).expect(403);
    await http().post(`/v1/projects/${randomUUID()}/refresh`).set(bearer(ctl.token)).expect(404);
  });

  it('eski agentd (projectOps e\'lon qilmagan): rejected(agent_outdated), dispatch yo\'q', async () => {
    const old = await newAgent('zz-old', CONTROL_OLD);
    await roundtrip(old, createEnvelope('agent.project_snapshot', snap('/zz/work/oldproj', { hash: HASH(50), tasksMd: TASKS_MD({}), tasksPath: 'TASKS.md', tasksMdHash: HASH(1) })));
    const [p] = await ds.query(`SELECT id FROM projects WHERE path = '/zz/work/oldproj'`);
    const res = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${p.id}/refresh`).set(bearer(ctl.token)).expect(201)).body);
    expect(res.command).toMatchObject({ status: 'rejected', errorCode: 'agent_outdated' });
    await old.expectNone('command.dispatch', 300);
  });

  it('append: step-up (boshqa qurilma tasdiqlaydi), dispatch payload (baseHash = snapshot xeshi), tasks_md_changed natijasi; ikki marta bosish = command_in_flight', async () => {
    const confirmer = await issue(['read', 'approve'], 'telegram');
    const body = { phase: 'Faza 1 — Test', tasks: [{ key: '1.4', title: 'Login ekrani', size: 'M' }, { key: '1.5', title: 'Parol tiklash' }] };
    await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(reader)).send(body).expect(403);
    await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ ...body, tasks: [{ key: '1.1', title: 'mavjud' }] }).expect(409);
    await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ ...body, tasks: [{ key: 'A B', title: 'x' }] }).expect(400);
    await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ ...body, tasks: [{ key: '2', title: 'a' }, { key: '2', title: 'b' }] }).expect(400);

    const before = stepUpRequests.length;
    const res = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send(body).expect(201)).body);
    expect(res.command).toMatchObject({ type: 'project.append_tasks', status: 'awaiting_confirmation', stepUp: { required: true, via: 'telegram' }, projectId });
    expect(res.command.promptPreview).toContain('1.4 Login ekrani [M]'); // step-up'da ko'rinadigan reja
    expect(stepUpRequests.length).toBe(before + 1);
    await agent.expectNone('command.dispatch', 300);
    // ikkinchi parallel append (xuddi shu loyiha): command_in_flight
    await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ ...body, tasks: [{ key: '1.9', title: 'boshqa' }] }).expect(409);

    expect((await svc(CommandsService).confirm(res.command.id, actorOf(confirmer.id))).outcome).toBe('confirmed');
    const d = await agent.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({
      type: 'project.append_tasks',
      payload: { root: PATH, tasksPath: 'docs/TASKS.md', baseHash: HASH(779), phase: 'Faza 1 — Test', tasks: [{ key: '1.4', title: 'Login ekrani', size: 'M' }, { key: '1.5', title: 'Parol tiklash' }] },
    });
    await agentRun(agent, res.command.id, { state: 'failed', error: { code: 'tasks_md_changed', message: 'TASKS.md changed since the snapshot' } });
    expect((await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [res.command.id]))[0]).toEqual({ status: 'failed', error_code: 'tasks_md_changed' });
  });

  it('append: step-up istisnosi ro\'yxatidagi qurilma ikkinchi tasdiqsiz o\'tadi; muvaffaqiyatli natija', async () => {
    await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify([ctl.id])]);
    try {
      const before = stepUpRequests.length;
      const res = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ phase: 'Faza 2 — Yangi', tasks: [{ key: '2.1', title: 'Yangi faza vazifasi' }] }).expect(201)).body);
      expect(res.command).toMatchObject({ status: 'sent', stepUp: { required: false } });
      expect(stepUpRequests.length).toBe(before);
      const d = await agent.nextOf('command.dispatch');
      expect(d.payload).toMatchObject({ type: 'project.append_tasks', payload: { phase: 'Faza 2 — Yangi' } });
      await agentRun(agent, res.command.id, { state: 'done', result: { append: { added: 1, skippedKeys: [], createdPhase: true, newHash: HASH(900) } } });
      expect((await ds.query(`SELECT status FROM commands WHERE id = $1`, [res.command.id]))[0].status).toBe('done');
    } finally {
      await ds.query(`DELETE FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    }
  });

  it('summarize: faqat tuzilgan statistika (titles/subjects redakt, kod/transcript yo\'q); natija daily_summaries\'ga, commands.result\'da matn YO\'Q; baho vazifaga biriktiriladi', async () => {
    await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(reader)).expect(403);
    await http().post(`/v1/projects/${projectId}/daily/2026-13-45/summary`).set(bearer(ctl.token)).expect(400);
    await http().post(`/v1/projects/${projectId}/daily/2099-01-01/summary`).set(bearer(ctl.token)).expect(400);
    await http().post(`/v1/projects/${projectId}/daily/2026-01-01/summary`).set(bearer(ctl.token)).expect(409); // faoliyat yo'q

    const res = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(201)).body);
    expect(res.command).toMatchObject({ type: 'project.summarize', status: 'sent', stepUp: { required: false }, projectId });
    const d = await agent.nextOf('command.dispatch');
    const p = d.payload.payload as { root: string; input: { day: string; tasks: Array<Record<string, unknown>>; commitSubjects: string[] } };
    expect(p.root).toBe(PATH);
    expect(p.input.day).toBe('2026-11-05');
    expect(p.input.tasks.map((t) => t.key).sort()).toEqual(['1.1', '1.2']);
    expect(Object.keys(p.input.tasks[0]!).sort()).toEqual(['activeSeconds', 'doneThatDay', 'estimateHours', 'key', 'sessions', 'title', 'totalTokens']);
    expect(p.input.commitSubjects).toEqual(['feat: doska token=[REDACTED]']); // commit sarlavhasi redakt
    expect(JSON.stringify(d.payload)).not.toContain('sk-ant-abcdefghijklmnop');
    expect(p.input.tasks.find((t) => t.key === '1.1')).toMatchObject({ doneThatDay: true, estimateHours: 6, activeSeconds: 600 });
    // Xuddi shu vaqtda ikkinchi xulosa: command_in_flight
    await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(409);

    const SUMMARY = 'MAXFIY-XULOSA-MATNI: kun yaxshi o\'tdi.';
    await agentRun(agent, res.command.id, {
      state: 'done',
      result: { summary: { summary: SUMMARY, model: 'claude-haiku-5-5', scores: [{ taskKey: '1.1', score: 5, reason: 'reja ichida' }, { taskKey: '1.2', score: 3, reason: 'sekin' }] } },
    });
    const [cmd] = await ds.query(`SELECT status, result::text AS r FROM commands WHERE id = $1`, [res.command.id]);
    expect(cmd.status).toBe('done');
    expect(cmd.r).not.toContain('MAXFIY-XULOSA');
    const [row] = await ds.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, summary, scores, model FROM daily_summaries WHERE project_id = $1`, [projectId]);
    expect(row).toMatchObject({ day: '2026-11-05', model: 'claude-haiku-5-5' });
    expect(row.summary).toBe(SUMMARY);

    const daily = DailyResponseSchema.parse((await http().get(`/v1/projects/${projectId}/daily?from=2026-11-05&to=2026-11-05`).set(bearer(reader)).expect(200)).body);
    expect(daily.days[0]!.summary).toMatchObject({ summary: SUMMARY, model: 'claude-haiku-5-5' });
    expect(daily.days[0]!.totals.avgScore).toBe(4);
    expect(daily.days[0]!.tasks.find((t) => t.taskKey === '1.1')!.score).toMatchObject({ score: 5, reason: 'reja ichida', day: '2026-11-05' });
    // "Baho" doskada: vazifaning eng so'nggi bahosi
    const board = ProjectTasksResponseSchema.parse((await http().get(`/v1/projects/${projectId}/tasks`).set(bearer(reader)).expect(200)).body).tasks;
    expect(board.find((t) => t.key === '1.2')!.score).toMatchObject({ score: 3 });
    expect(board.find((t) => t.key === '1.3')!.score).toBeNull();
  });

  it('summarize: agent xato qaytarsa buyruq failed, mavjud xulosa o\'zgarmaydi; yaroqsiz natija = failed(invalid_result)', async () => {
    const before = (await ds.query(`SELECT summary FROM daily_summaries WHERE project_id = $1`, [projectId]))[0].summary as string;
    const r1 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(201)).body);
    await agent.nextOf('command.dispatch');
    await agentRun(agent, r1.command.id, { state: 'failed', error: { code: 'summarize_failed', message: 'claude -p did not complete' } });
    expect((await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [r1.command.id]))[0]).toEqual({ status: 'failed', error_code: 'summarize_failed' });

    const r2 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(201)).body);
    await agent.nextOf('command.dispatch');
    await agentRun(agent, r2.command.id, { state: 'done', result: { summary: { summary: '', model: 'm', scores: [{ taskKey: '1.1', score: 99, reason: 'x' }] } } });
    expect((await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [r2.command.id]))[0]).toEqual({ status: 'failed', error_code: 'invalid_result' });
    expect((await ds.query(`SELECT summary FROM daily_summaries WHERE project_id = $1`, [projectId]))[0].summary).toBe(before);
  });

  it('har buyruq audit_log\'da: command.created dispatchdan oldin; lockdown\'da project buyruqlari 403', async () => {
    const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'command.created' AND details->>'project_id' = $1`, [projectId]);
    expect(n).toBeGreaterThanOrEqual(5);
    await svc(LockdownService).set(true, 'test');
    try {
      await http().post(`/v1/projects/${projectId}/refresh`).set(bearer(ctl.token)).expect(403);
      await http().post(`/v1/projects/${projectId}/md-extract`).set(bearer(ctl.token)).send({ path: 'README.md' }).expect(403);
      await http().post(`/v1/projects/${projectId}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(403);
      await http().post(`/v1/projects/${projectId}/tasks/append`).set(bearer(ctl.token)).send({ phase: 'x', tasks: [{ key: '7.7', title: 'y' }] }).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });

  it('6.18 qism bo\'yicha kunlik xulosa: faqat qism vazifalari yuboriladi, alohida saqlanadi (loyiha+kun+qism), butun loyiha xulosasi o\'zgarmaydi', async () => {
    const ROOT = '/zz/parts/agro';
    const pa = await newAgent('zz-part');
    const mkPart = (path: string, status: 'todo' | 'done') => ({
      path, name: path, planFiles: [`${path}/TODO.md`], counts: { todo: status === 'todo' ? 1 : 0, doing: 0, done: status === 'done' ? 1 : 0, unknown: 0, total: 1 },
      items: [{ key: '1', title: `Band ${path}`, phase: 'Faza', status }], itemsTruncated: false, readTruncated: false,
    });
    const psnap = (hash: number, takenAt: string, web: 'todo' | 'done', extra: Record<string, unknown> = {}) =>
      snap(ROOT, { kind: 'dir', hash: HASH(hash), takenAt: T(takenAt), parts: [mkPart('web-app', web), mkPart('backend', 'todo')], commits: [{ sha: 'c'.repeat(40), subject: 'feat: umumiy commit', author: 'Ali', ts: T('2026-11-05T09:00:00Z') }], ...extra });
    await roundtrip(pa, createEnvelope('agent.project_snapshot', psnap(11, '2026-11-05T05:00:00Z', 'todo')));
    await roundtrip(pa, createEnvelope('agent.project_snapshot', psnap(12, '2026-11-05T12:00:00Z', 'done')));
    const [pr] = await ds.query(`SELECT id FROM projects WHERE path = $1`, [ROOT]);
    const pid = pr.id as string;

    await roundtrip(pa, createEnvelope('agent.events', { events: [
      { ...ev('pt-web', 'UserPromptSubmit', 'working', '2026-11-05T10:00:00Z', `${ROOT}/web-app`, { taskKey: '1', taskSource: 'explicit' }), rootKind: 'dir' },
      { ...ev('pt-web', 'Stop', 'done', '2026-11-05T10:20:00Z', `${ROOT}/web-app`), rootKind: 'dir' },
      { ...ev('pt-be', 'UserPromptSubmit', 'working', '2026-11-05T11:00:00Z', `${ROOT}/backend`, { taskKey: '1', taskSource: 'explicit' }), rootKind: 'dir' },
      { ...ev('pt-be', 'Stop', 'done', '2026-11-05T11:30:00Z', `${ROOT}/backend`), rootKind: 'dir' },
    ] }));
    const dailyOf = async (qs = '') => DailyResponseSchema.parse((await http().get(`/v1/projects/${pid}/daily?from=2026-11-05&to=2026-11-05${qs}`).set(bearer(reader)).expect(200)).body).days[0]!;
    expect((await dailyOf()).tasks.map((t) => t.taskKey).sort()).toEqual(['backend:1', 'web-app:1']);

    // noto'g'ri qism / ortiqcha maydon / reader
    await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: '../etc' }).expect(400);
    await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: 'web-app', x: 1 }).expect(400);
    await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(reader)).send({ part: 'web-app' }).expect(403);
    // faoliyati yo'q qism: 409
    await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: 'mobile' }).expect(409);

    // 1) faqat web-app
    const r1 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: 'web-app' }).expect(201)).body);
    const d1 = await pa.nextOf('command.dispatch');
    const p1 = d1.payload.payload as { input: { tasks: Array<{ key: string }>; commitSubjects: string[] }; part?: unknown };
    expect(p1.input.tasks.map((t) => t.key)).toEqual(['web-app:1']);
    expect(p1.input.commitSubjects).toEqual([]); // commit'lar qismga bog'lanmagan
    expect(JSON.stringify(d1.payload)).not.toContain('"part"'); // part agentga yuborilmaydi (imzolangan payload o'zgarmaydi)
    expect((await ds.query(`SELECT payload->>'part' AS part FROM commands WHERE id = $1`, [r1.command.id]))[0].part).toBe('web-app');
    await agentRun(pa, r1.command.id, { state: 'done', result: { summary: { summary: 'WEB-XULOSA', model: 'claude-haiku-5-5', scores: [{ taskKey: 'web-app:1', score: 4, reason: 'yaxshi' }] } } });
    expect((await ds.query(`SELECT part, summary FROM daily_summaries WHERE project_id = $1`, [pid]))).toEqual([{ part: 'web-app', summary: 'WEB-XULOSA' }]);
    expect((await dailyOf('&part=web-app')).summary).toMatchObject({ summary: 'WEB-XULOSA' });
    expect((await dailyOf('&part=web-app')).totals.avgScore).toBe(4);
    expect((await dailyOf()).summary).toBeNull(); // butun loyiha xulosasi hali yo'q
    expect((await dailyOf('&part=backend')).summary).toBeNull();
    expect((await dailyOf('&part=')).summary).toBeNull();

    // 2) butun loyiha (tanasiz): ikkala qism vazifalari + commit; alohida qator
    const r2 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).expect(201)).body);
    const d2 = await pa.nextOf('command.dispatch');
    const p2 = d2.payload.payload as { input: { tasks: Array<{ key: string }>; commitSubjects: string[] } };
    expect(p2.input.tasks.map((t) => t.key).sort()).toEqual(['backend:1', 'web-app:1']);
    expect(p2.input.commitSubjects).toEqual(['feat: umumiy commit']);
    expect((await ds.query(`SELECT payload->>'part' AS part FROM commands WHERE id = $1`, [r2.command.id]))[0].part).toBeNull();
    await agentRun(pa, r2.command.id, { state: 'done', result: { summary: { summary: 'BUTUN-XULOSA', model: 'claude-haiku-5-5', scores: [{ taskKey: 'web-app:1', score: 5, reason: 'a' }, { taskKey: 'backend:1', score: 2, reason: 'b' }] } } });
    const rows: Array<{ part: string; summary: string }> = await ds.query(`SELECT part, summary FROM daily_summaries WHERE project_id = $1 ORDER BY part`, [pid]);
    expect(rows).toEqual([{ part: '', summary: 'BUTUN-XULOSA' }, { part: 'web-app', summary: 'WEB-XULOSA' }]);
    expect((await dailyOf()).summary).toMatchObject({ summary: 'BUTUN-XULOSA' });
    expect((await dailyOf('&part=web-app')).summary).toMatchObject({ summary: 'WEB-XULOSA' });
    expect((await dailyOf('&part=')).summary).toMatchObject({ summary: 'BUTUN-XULOSA' });

    // 3) qayta yaratish = shu qism qatorini almashtiradi (boshqalari tegilmaydi)
    const r3 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: 'backend' }).expect(201)).body);
    await pa.nextOf('command.dispatch');
    await agentRun(pa, r3.command.id, { state: 'done', result: { summary: { summary: 'BACK-1', model: 'm', scores: [] } } });
    const r4 = ProjectCommandResponseSchema.parse((await http().post(`/v1/projects/${pid}/daily/2026-11-05/summary`).set(bearer(ctl.token)).send({ part: 'backend' }).expect(201)).body);
    await pa.nextOf('command.dispatch');
    await agentRun(pa, r4.command.id, { state: 'done', result: { summary: { summary: 'BACK-2', model: 'm', scores: [] } } });
    expect((await ds.query(`SELECT part, summary FROM daily_summaries WHERE project_id = $1 ORDER BY part`, [pid])).map((r: { part: string; summary: string }) => `${r.part}=${r.summary}`)).toEqual(['=BUTUN-XULOSA', 'backend=BACK-2', 'web-app=WEB-XULOSA']);

  }, 60_000);
});
