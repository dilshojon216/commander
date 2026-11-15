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
  CLIENT_WS_CLOSE,
  CLIENT_WS_PATH,
  CLIENT_WS_SUBPROTOCOL,
  buildAgentAuthString,
  buildClientSubprotocols,
  createEnvelope,
  ApprovalDecisionResponseSchema,
  LimitsResponseSchema,
  ListApprovalsResponseSchema,
  ListMachinesResponseSchema,
  ListProjectsResponseSchema,
  ListSessionEventsResponseV1Schema,
  ListSessionsResponseV1Schema,
  SessionDtoSchema,
  UsageResponseSchema,
  UsageSummaryResponseSchema,
} from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { ApprovalsService } from '../../src/approvals/approvals.service.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { DevicesService } from '../../src/identity/devices/devices.service.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;
const LEGACY = 'legacy-hook-secret';

/**
 * 1.5 / 1.6 / 1.7 (center tomoni): haqiqiy TimescaleDB + haqiqiy `ws` (agent va klient) + haqiqiy Ed25519 + klient tokenlari.
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Sock {
  ws: WebSocket;
  next: (ms?: number) => Promise<Msg>;
  /** Berilgan turdagi keyingi xabar (boshqalari inbox'da qoladi). */
  nextOf: (type: string, ms?: number) => Promise<Msg>;
  nextWhere: (match: (m: Msg) => boolean, ms?: number, label?: string) => Promise<Msg>;
  /** `ms` ichida `type` xabari KELMASLIGINI tekshiradi. */
  expectNone: (type: string, ms?: number) => Promise<void>;
  send: (m: unknown) => void;
  closed: Promise<number>;
  opened: Promise<void>;
  all: Msg[];
}
interface Agent extends Sock { deviceId: string; machineId: string; keys: { priv: KeyObject; pubB64: string } }

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: LEGACY })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      EventsModule,
      ApprovalsModule,
      LimitsModule,
      ApiModule,
      AgentModule,
      RealtimeModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 5000, revokeCheckIntervalMs: 100 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    // Muddat tekshiruvi qo'lda (`sweepExpired()`): vaqtga bog'liq poyga yo'q.
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  port = (app.getHttpServer().address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Push kanallarida (sessions/machines/approvals) oldingi testlar yoki fon sweep'laridan kechikkan
// xabarlar kelishi mumkin: "keyingi har qanday X" emas, aynan shu testnikini kutamiz (6.19).
const sessionUpdate = (claudeSessionId: string) => (m: Msg): boolean =>
  m.type === 'session.updated' && (m.payload.session as { claudeSessionId?: string }).claudeSessionId === claudeSessionId;
const machineUpdate = (machineId: string) => (m: Msg): boolean =>
  m.type === 'machine.updated' && (m.payload.machine as { id?: string }).id === machineId;
const approvalPush = (type: 'approval.created' | 'approval.resolved', approvalId: string) => (m: Msg): boolean =>
  m.type === type && (m.payload.approval as { id?: string }).id === approvalId;

// --- ws yordamchilari ----------------------------------------------------------------------------

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
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    next: (ms = 3000) => waitFor(() => true, ms, 'any message'),
    nextOf: (type, ms = 3000) => waitFor((m) => m.type === type, ms, type),
    nextWhere: (match, ms = 3000, label = 'matching message') => waitFor(match, ms, label),
    expectNone: async (type, ms = 400) => {
      const start = all.length; // faqat shu chaqiruvdan KEYIN kelganlar
      await sleep(ms);
      expect(all.slice(start).filter((m) => m.type === type)).toHaveLength(0);
    },
  };
}

async function enrollAgent(name = 'zz-1.5'): Promise<{ deviceId: string; machineId: string; keys: Agent['keys'] }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: keys.pubB64, hardware_id: `hw-1.5-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys };
}

async function connectAgent(e: { deviceId: string; machineId: string; keys: Agent['keys'] }): Promise<Agent> {
  const c = openSocket(AGENT_WS_PATH);
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId: e.deviceId, ts, signature, agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', hostname: 'zz-host', os: 'linux' }));
  expect((await c.nextOf('auth.ok')).type).toBe('auth.ok');
  return { ...c, deviceId: e.deviceId, machineId: e.machineId, keys: e.keys };
}

async function newAgent(name?: string): Promise<Agent> {
  return connectAgent(await enrollAgent(name));
}

async function roundtrip(a: Agent, env: ReturnType<typeof createEnvelope>): Promise<Msg> {
  a.send(env);
  // Faqat O'Z xabarimizga javob (boshqa test qoldirgan ack/nack aralashmasin).
  return a.nextWhere((m) => (m.type === 'ack' && (m.payload.ids as string[]).includes(env.id)) || (m.type === 'nack' && m.payload.id === env.id), 3000, `ack/nack for ${env.type}`);
}

async function issueToken(scopes: string[], name = 'zz-test'): Promise<{ id: string; token: string }> {
  const t = await svc(ClientTokensService).issue({ kind: 'web', name: `${name}-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
}

async function connectClient(token: string, mode: 'subprotocol' | 'message' = 'subprotocol'): Promise<Sock> {
  const c = mode === 'subprotocol' ? openSocket(CLIENT_WS_PATH, buildClientSubprotocols(token)) : openSocket(CLIENT_WS_PATH);
  await c.opened;
  if (mode === 'message') c.send(createEnvelope('auth', { token }));
  expect((await c.nextOf('auth.ok')).type).toBe('auth.ok');
  return c;
}

async function subscribe(c: Sock, channels: string[]): Promise<void> {
  c.send(createEnvelope('subscribe', { channels }));
  await c.nextOf('subscribed');
}

const ev = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), claudeSessionId: 's-1', event: 'PreToolUse', status: 'working', cwd: '/zz/work/commander', ts: Date.now(), ...over,
});
const usage = (over: Record<string, unknown> = {}) => ({
  requestId: `req_${randomBytes(4).toString('hex')}`, claudeSessionId: 's-1', cwd: '/zz/work/commander', model: 'claude-test',
  inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.5, source: 'otel' as const, ts: Date.now(), ...over,
});
const approvalReq = (over: Record<string, unknown> = {}) => ({
  approvalId: randomUUID(), claudeSessionId: 's-1', toolName: 'Bash', toolInputRedacted: '{"command":"npm test"}', toolInputFullHash: 'a'.repeat(64),
  cwd: '/zz/work/commander', deadline: Date.now() + 120_000, ...over,
});
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Hamma testlar uchun umumiy o'qish tokeni va seed. */
let reader: { id: string; token: string };
let agentA: Agent;
let agentB: Agent;
let sessionA = '';

describe('REST auth (/v1 read API)', () => {
  beforeAll(async () => {
    reader = await issueToken(['read'], 'reader');
  });

  const routes = ['/v1/machines', '/v1/sessions', '/v1/projects', '/v1/usage', '/v1/usage/summary', '/v1/limits', '/v1/approvals'];

  it('every read route: no token 401, garbage token 401, legacy AUTH_TOKEN 401, wrong-scope token 403, read token 200', async () => {
    const approveOnly = await issueToken(['approve'], 'approve-only');
    for (const r of routes) {
      await http().get(r).expect(401);
      await http().get(r).set(bearer('cmdr_garbage')).expect(401);
      await http().get(r).set(bearer(LEGACY)).expect(401);
      await http().get(r).set(bearer(approveOnly.token)).expect(403);
      await http().get(r).set(bearer(reader.token)).expect(200);
    }
  });

  it('a revoked token is rejected immediately, an admin token reads everything', async () => {
    const t = await issueToken(['read'], 'to-revoke');
    await http().get('/v1/machines').set(bearer(t.token)).expect(200);
    await svc(DevicesService).revoke(t.id, 'client', 'test');
    await http().get('/v1/machines').set(bearer(t.token)).expect(401);
    const admin = await issueToken(['admin'], 'admin');
    await http().get('/v1/machines').set(bearer(admin.token)).expect(200);
  });

  it('query params are Zod-validated: unknown key, bad enum and out-of-range values are 400 with issues', async () => {
    const bad = [
      '/v1/sessions?bogus=1', '/v1/sessions?limit=0', '/v1/sessions?limit=9999', '/v1/sessions?status=stale', '/v1/sessions?active=maybe', '/v1/sessions?cursor=garbage',
      '/v1/usage?bucket=10m', '/v1/usage?groupBy=user', '/v1/usage?from=yesterday', '/v1/usage?project=notauuid', '/v1/projects?limit=-1', '/v1/approvals?recentLimit=500',
      '/v1/sessions/not-a-uuid', '/v1/sessions/not-a-uuid/events',
    ];
    for (const url of bad) {
      const res = await http().get(url).set(bearer(reader.token)).expect(400);
      expect(res.body.error).toBe('invalid_request');
    }
    const res = await http().get('/v1/sessions?limit=0').set(bearer(reader.token)).expect(400);
    expect(res.body.issues[0].path).toBe('limit');
  });
});

describe('seeded fleet: machines, sessions, projects, usage', () => {
  const t0 = Date.now();

  beforeAll(async () => {
    agentA = await newAgent('zz-alpha');
    agentB = await newAgent('zz-beta');
    // A: ikkita loyiha, ikki sessiya; B: bitta sessiya
    await roundtrip(agentA, createEnvelope('agent.events', { events: [
      ev({ claudeSessionId: 'sa-1', cwd: '/zz/work/commander', status: 'working', ts: t0 - 3000 }),
      ev({ claudeSessionId: 'sa-2', cwd: '/zz/work/other', status: 'waiting', event: 'Notification', ts: t0 - 2000, message: 'Needs input', notificationType: 'idle_prompt' }),
    ] }));
    await roundtrip(agentB, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'sb-1', cwd: '/zz/work/commander', status: 'idle', event: 'SessionStart', ts: t0 - 1000 })] }));
    await roundtrip(agentA, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'sa-1', status: 'working', event: 'PostToolUse', ts: t0 - 500 })] }));
    // sessiya tugagan (active=1 undan o'tmasin)
    await roundtrip(agentB, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'sb-old', cwd: '/zz/work/old', status: 'ended', event: 'SessionEnd', reason: 'logout', ts: t0 - 900 })] }));
    // usage: A/commander 2 so'rov (1h oldin va hozir), A/other 1, B/commander 1, cwd'siz 1
    await roundtrip(agentA, createEnvelope('agent.usage', { records: [
      usage({ requestId: 'u-a-c-1', claudeSessionId: 'sa-1', cwd: '/zz/work/commander', inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.5, ts: t0 - 100 }),
      usage({ requestId: 'u-a-c-2', claudeSessionId: 'sa-1', cwd: '/zz/work/commander', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.25, ts: t0 - 200 }),
      usage({ requestId: 'u-a-o-1', claudeSessionId: 'sa-2', cwd: '/zz/work/other', inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheCreationTokens: 10, costUsd: null, ts: t0 - 300 }),
      usage({ requestId: 'u-a-n-1', claudeSessionId: 'sa-unknown', cwd: undefined, inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, ts: t0 - 400 }),
    ] }));
    await roundtrip(agentB, createEnvelope('agent.usage', { records: [usage({ requestId: 'u-b-c-1', claudeSessionId: 'sb-1', cwd: '/zz/work/commander', inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, costUsd: 0.1, ts: t0 - 150 })] }));
  });

  it('GET /v1/machines: online, os, versions and open session counts by status', async () => {
    const res = await http().get('/v1/machines').set(bearer(reader.token)).expect(200);
    const body = ListMachinesResponseSchema.parse(res.body);
    expect(body.onlineCount).toBeGreaterThanOrEqual(2);
    const a = body.items.find((m) => m.id === agentA.machineId)!;
    expect(a).toMatchObject({ online: true, os: 'linux', agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', identityStatus: 'verified' });
    expect(a.sessions).toMatchObject({ open: 2, working: 1, waiting: 1, awaitingApproval: 0 });
    const b = body.items.find((m) => m.id === agentB.machineId)!;
    expect(b.sessions).toMatchObject({ open: 1, idle: 1 }); // ended sessiya "open" emas
    expect(a.lastSeenAt).not.toBeNull();
  });

  it('GET /v1/sessions: items carry project name and stale_since; filters machine (uuid and slug), project, status, active', async () => {
    const all = ListSessionsResponseV1Schema.parse((await http().get('/v1/sessions').set(bearer(reader.token)).expect(200)).body);
    expect(all.items.map((s) => s.claudeSessionId).sort()).toEqual(['sa-1', 'sa-2', 'sb-1', 'sb-old']);
    const sa1 = all.items.find((s) => s.claudeSessionId === 'sa-1')!;
    sessionA = sa1.id;
    expect(sa1).toMatchObject({ projectName: 'commander', status: 'working', staleSince: null, pendingApprovals: 0, machineId: agentA.machineId });
    expect(sa1.projectId).not.toBeNull();

    const byUuid = ListSessionsResponseV1Schema.parse((await http().get(`/v1/sessions?machine=${agentA.machineId}`).set(bearer(reader.token)).expect(200)).body);
    expect(byUuid.items.map((s) => s.claudeSessionId).sort()).toEqual(['sa-1', 'sa-2']);
    const slug = sa1.machineSlug;
    const bySlug = ListSessionsResponseV1Schema.parse((await http().get(`/v1/sessions?machine=${slug}`).set(bearer(reader.token)).expect(200)).body);
    expect(bySlug.items).toHaveLength(2);

    const byProject = ListSessionsResponseV1Schema.parse((await http().get('/v1/sessions?project=Commander').set(bearer(reader.token)).expect(200)).body);
    expect(byProject.items.map((s) => s.claudeSessionId).sort()).toEqual(['sa-1', 'sb-1']);
    const byProjectId = ListSessionsResponseV1Schema.parse((await http().get(`/v1/sessions?project=${sa1.projectId}`).set(bearer(reader.token)).expect(200)).body);
    expect(byProjectId.items.map((s) => s.claudeSessionId)).toEqual(['sa-1']);

    const waiting = ListSessionsResponseV1Schema.parse((await http().get('/v1/sessions?status=waiting').set(bearer(reader.token)).expect(200)).body);
    expect(waiting.items.map((s) => s.claudeSessionId)).toEqual(['sa-2']);
    expect(waiting.items[0]).toMatchObject({ message: 'Needs input', notificationType: 'idle_prompt' });

    const active = ListSessionsResponseV1Schema.parse((await http().get('/v1/sessions?active=1').set(bearer(reader.token)).expect(200)).body);
    expect(active.items.map((s) => s.claudeSessionId).sort()).toEqual(['sa-1', 'sa-2', 'sb-1']);
  });

  it('GET /v1/sessions pagination is stable (keyset cursor, no duplicates, no gaps)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const url: string = `/v1/sessions?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const page = ListSessionsResponseV1Schema.parse((await http().get(url).set(bearer(reader.token)).expect(200)).body);
      seen.push(...page.items.map((s) => s.claudeSessionId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual(['sa-1', 'sa-2', 'sb-1', 'sb-old']);
  });

  it('GET /v1/sessions/:id and /events; unknown id 404', async () => {
    const one = SessionDtoSchema.parse((await http().get(`/v1/sessions/${sessionA}`).set(bearer(reader.token)).expect(200)).body);
    expect(one.claudeSessionId).toBe('sa-1');
    await http().get(`/v1/sessions/${randomUUID()}`).set(bearer(reader.token)).expect(404);
    await http().get(`/v1/sessions/${randomUUID()}/events`).set(bearer(reader.token)).expect(404);

    const page1 = ListSessionEventsResponseV1Schema.parse((await http().get(`/v1/sessions/${sessionA}/events?limit=1`).set(bearer(reader.token)).expect(200)).body);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.event).toBe('PostToolUse'); // eng yangisi birinchi
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ListSessionEventsResponseV1Schema.parse((await http().get(`/v1/sessions/${sessionA}/events?limit=5&cursor=${page1.nextCursor}`).set(bearer(reader.token)).expect(200)).body);
    expect(page2.items.map((e) => e.event)).toEqual(['PreToolUse']);
    expect(page2.nextCursor).toBeNull();
  });

  it('GET /v1/projects: per-project today and all-time totals, unattributed bucket, Tashkent day boundary', async () => {
    const body = ListProjectsResponseSchema.parse((await http().get('/v1/projects').set(bearer(reader.token)).expect(200)).body);
    expect(body.timezone).toBe('Asia/Tashkent');
    const commanderA = body.items.find((p) => p.machineId === agentA.machineId && p.name === 'commander')!;
    // 100+50+1000+10 + 200
    expect(commanderA.allTime).toMatchObject({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, totalTokens: 1360, requests: 2 });
    expect(commanderA.allTime.costUsd).toBeCloseTo(0.75, 6);
    expect(commanderA.firstUsedAt).not.toBeNull();
    // lastUsedAt kun boshi emas, haqiqiy oxirgi faollik (sessiya hodisasi): loyihalar jadvalida hammasi bir xil chiqmasin
    expect(Date.parse(commanderA.lastUsedAt!)).toBeGreaterThanOrEqual(t0 - 5_000);
    expect(commanderA.openSessions).toBe(1);
    const other = body.items.find((p) => p.name === 'other')!;
    expect(other.allTime.costUsd).toBeNull();
    expect(other.allTime.totalTokens).toBe(40);
    // "bugun" = Asia/Tashkent kuni: usage bugungi kunga tushgan bo'lsa (yarim kecha chegarasidan keyin) today == allTime
    if (Date.parse(body.todayStart) <= t0 - 500) expect(commanderA.today).toEqual(commanderA.allTime);
    // eng ko'p token bugun birinchi
    expect(body.items[0]!.today.totalTokens).toBeGreaterThanOrEqual(body.items[body.items.length - 1]!.today.totalTokens);
    expect(body.unattributed.allTime.inputTokens).toBe(7);
    expect(Date.parse(body.todayStart)).toBeGreaterThan(Date.now() - 24 * 3_600_000 - 1000);
  });

  it('GET /v1/projects?machine= filters by machine (uuid or slug)', async () => {
    const body = ListProjectsResponseSchema.parse((await http().get(`/v1/projects?machine=${agentB.machineId}`).set(bearer(reader.token)).expect(200)).body);
    expect(body.items.every((p) => p.machineId === agentB.machineId)).toBe(true);
    expect(body.items.map((p) => p.name)).toContain('commander');
  });

  it('GET /v1/usage: source selection, grouping and totals for each bucket', async () => {
    const from = new Date(t0 - 3_600_000).toISOString();
    const to = new Date(t0 + 60_000).toISOString();
    const grandTotal = 1360 + 40 + 7 + 4; // A/commander + A/other + cwd'siz + B/commander

    const none = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1h&from=${from}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(none.source).toBe('usage_1h');
    expect(none.series).toHaveLength(1);
    expect(none.series[0]).toMatchObject({ key: null, label: 'total' });
    expect(none.series[0]!.total.totalTokens).toBe(grandTotal);
    expect(none.series[0]!.total.requests).toBe(5);

    const byMachine = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=5m&groupBy=machine&from=${from}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(byMachine.source).toBe('usage_5m');
    const a = byMachine.series.find((s) => s.key === agentA.machineId)!;
    expect(a.total.totalTokens).toBe(1360 + 40 + 7);
    expect(a.label).toMatch(/^zz-alpha/);
    expect(byMachine.series.find((s) => s.key === agentB.machineId)!.total.totalTokens).toBe(4);

    const byProject = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1h&groupBy=project&from=${from}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(byProject.source).toBe('raw'); // cagg'larda loyiha o'lchami yo'q
    // bir xil nomli ikki loyiha (A va B mashinalarida) alohida seriya: umumiy yig'indi
    expect(byProject.series.filter((s) => s.label === 'commander')).toHaveLength(2);
    expect(byProject.series.filter((s) => s.label === 'commander').reduce((n, s) => n + s.total.totalTokens, 0)).toBe(1360 + 4);
    expect(byProject.series.find((s) => s.key === 'unknown')!.total.totalTokens).toBe(7);

    const byModel = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1h&groupBy=model&from=${from}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(byModel.series).toHaveLength(1);
    expect(byModel.series[0]!.key).toBe('claude-test');

    const daily = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1d&groupBy=project&from=${new Date(t0 - 2 * 86_400_000).toISOString()}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(daily.source).toBe('daily_by_project');
    expect(daily.series.reduce((s, x) => s + x.total.totalTokens, 0)).toBe(grandTotal);
    for (const s of daily.series) for (const p of s.points) {
      // kun chegarasi Asia/Tashkent yarim kechasi: UTC 19:00
      expect(new Date(p.t).getUTCHours()).toBe(19);
    }

    const dailyMachine = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1d&groupBy=machine&from=${new Date(t0 - 2 * 86_400_000).toISOString()}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(dailyMachine.source).toBe('usage_1h');
    expect(dailyMachine.series.find((s) => s.key === agentB.machineId)!.total.totalTokens).toBe(4);

    const filtered = UsageResponseSchema.parse((await http().get(`/v1/usage?bucket=1h&machine=${agentB.machineId}&from=${from}&to=${to}`).set(bearer(reader.token)).expect(200)).body);
    expect(filtered.series[0]!.total.totalTokens).toBe(4);
  });

  it('GET /v1/usage rejects inverted and over-long ranges for the bucket', async () => {
    const now = new Date().toISOString();
    await http().get(`/v1/usage?bucket=5m&from=${now}&to=${new Date(Date.now() - 1000).toISOString()}`).set(bearer(reader.token)).expect(400);
    await http().get(`/v1/usage?bucket=5m&from=${new Date(Date.now() - 10 * 86_400_000).toISOString()}&to=${now}`).set(bearer(reader.token)).expect(400);
    const defaults = UsageResponseSchema.parse((await http().get('/v1/usage?bucket=1d').set(bearer(reader.token)).expect(200)).body);
    expect(Date.parse(defaults.to) - Date.parse(defaults.from)).toBe(30 * 86_400_000);
  });

  it('GET /v1/usage/summary: today / 7d / 30d / all-time (Asia/Tashkent), cost flagged api_equivalent', async () => {
    const body = UsageSummaryResponseSchema.parse((await http().get('/v1/usage/summary').set(bearer(reader.token)).expect(200)).body);
    expect(body.costKind).toBe('api_equivalent');
    expect(body.allTime.totals.totalTokens).toBe(1360 + 40 + 7 + 4);
    expect(body.last30d.totals.totalTokens).toBe(body.allTime.totals.totalTokens);
    expect(body.last7d.totals.totalTokens).toBe(body.allTime.totals.totalTokens);
    expect(body.today.totals.totalTokens).toBeLessThanOrEqual(body.last7d.totals.totalTokens);
    expect(Date.parse(body.last7d.from!)).toBe(Date.parse(body.today.from!) - 6 * 86_400_000);
    expect(body.allTime.from).toBeNull();
  });
});

describe('GET /v1/limits (PLAN 6.3)', () => {
  const MIN = 60_000;
  const insert = (machineId: string, ts: number, five: [number, number] | null, seven: [number, number] | null) =>
    ds.query(
      `INSERT INTO limit_samples (ts, machine_id, source, five_hour_used_pct, five_hour_resets_at, seven_day_used_pct, seven_day_resets_at)
       VALUES (to_timestamp($1 / 1000.0), $2, 'official', $3, to_timestamp($4 / 1000.0), $5, to_timestamp($6 / 1000.0))`,
      [ts, machineId, five?.[0] ?? null, five?.[1] ?? null, seven?.[0] ?? null, seven?.[1] ?? null],
    );
  const get = async () => LimitsResponseSchema.parse((await http().get('/v1/limits').set(bearer(reader.token)).expect(200)).body);

  beforeEach(async () => {
    // Boshqa testlarning usage'i hisobga aralashmasin (limit akkaunt bo'yicha barcha tokenlarni sanaydi).
    await ds.query(`DELETE FROM limit_samples`);
    await ds.query(`DELETE FROM token_usage`);
  });

  it('no observations: both windows null (nothing is invented)', async () => {
    const l = await get();
    expect(l.fiveHour).toBeNull();
    expect(l.sevenDay).toBeNull();
    expect(l.freshSeconds).toBe(180);
  });

  it('newest official observation across machines wins; fresh -> official, not stale', async () => {
    const now = Date.now();
    await insert(agentA.machineId, now - 10 * MIN, [30, now + 2 * 3_600_000], [10, now + 3 * 86_400_000]);
    await insert(agentB.machineId, now - 20_000, [35.5, now + 2 * 3_600_000], null); // eng yangisi, faqat 5h
    const l = await get();
    expect(l.fiveHour).toMatchObject({ usedPct: 35.5, source: 'official', stale: false, reset: false, observedByMachineId: agentB.machineId });
    expect(l.fiveHour!.ageSeconds).toBeGreaterThanOrEqual(20);
    // 7d uchun eng yangi 7d kuzatuvi A'dan (B'ning 7d maydoni yo'q)
    expect(l.sevenDay).toMatchObject({ usedPct: 10, source: 'official', observedByMachineId: agentA.machineId, stale: true });
  });

  it('resetsAt passed -> reported as reset: 0% estimate, source=estimate (no calibration)', async () => {
    const now = Date.now();
    await insert(agentA.machineId, now - 6 * 3_600_000, [93, now - 60 * MIN], [95, now - 24 * 3_600_000]);
    const l = await get();
    expect(l.fiveHour).toMatchObject({ usedPct: 0, source: 'estimate', reset: true, resetsAt: null }); // usage yo'q: yangi oyna hali boshlanmagan
    expect(l.fiveHour!.anchor!.usedPct).toBe(93);
    expect(l.sevenDay).toMatchObject({ usedPct: 0, source: 'estimate', reset: true });
    expect(Date.parse(l.sevenDay!.resetsAt!)).toBeGreaterThan(now); // keyingi haftalik chegara
  });

  it('calibration from consecutive observations + usage between them; stale official is extrapolated as an estimate', async () => {
    const now = Date.now();
    const resets = now + 3 * 3_600_000;
    // 50 daqiqa oldin 10%, 40 daqiqa oldin 14%, orada 1000 vaznli token (input) => 0.004 %/token
    await insert(agentA.machineId, now - 50 * MIN, [10, resets], null);
    await insert(agentA.machineId, now - 40 * MIN, [14, resets], null);
    await ds.query(
      `INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source)
       VALUES (to_timestamp($1 / 1000.0), $2, 'lim-between', 'claude-test', 1000, 0, 0, 0, 'otel')`,
      [now - 45 * MIN, agentA.machineId],
    );
    // 30 daqiqa oldin 14% (oxirgi kuzatuv), keyin 2000 token (BOSHQA mashinadan: limit akkaunt bo'yicha)
    await insert(agentA.machineId, now - 30 * MIN, [14, resets], null);
    await ds.query(
      `INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source)
       VALUES (to_timestamp($1 / 1000.0), $2, 'lim-after', 'claude-test', 2000, 0, 0, 0, 'otel')`,
      [now - 10 * MIN, agentB.machineId],
    );
    const l = await get();
    expect(l.fiveHour!.calibration!.coefficient).toBeCloseTo(0.004, 6);
    expect(l.fiveHour).toMatchObject({ source: 'estimate', stale: true, reset: false });
    expect(l.fiveHour!.usedPct).toBeCloseTo(14 + 0.004 * 2000, 2); // 22
    expect(l.fiveHour!.anchor).toMatchObject({ usedPct: 14 });
  });
});

describe('approvals: agent -> center -> client -> agent', () => {
  let approver: { id: string; token: string };
  let approver2: { id: string; token: string };
  let readOnly: { id: string; token: string };
  let a: Agent;
  const tokenIn = (id: string) => ds.query(`SELECT status, decision_message, decided_by_device_id, delivered_at, tool_input_redacted FROM approvals WHERE id = $1`, [id]);

  beforeAll(async () => {
    approver = await issueToken(['read', 'approve'], 'approver');
    approver2 = await issueToken(['read', 'approve'], 'approver2');
    readOnly = await issueToken(['read'], 'ro');
    a = await newAgent('zz-approvals');
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ap-1', status: 'working' })] }));
  });

  async function request(over: Record<string, unknown> = {}, agent: Agent = a) {
    const p = approvalReq({ claudeSessionId: 'ap-1', ...over });
    const reply = await roundtrip(agent, createEnvelope('approval.request', p));
    return { p, reply };
  }
  const sessionStatus = async (agent: Agent, sid = 'ap-1') => ((await ds.query(`SELECT status FROM sessions WHERE machine_id = $1 AND claude_session_id = $2`, [agent.machineId, sid]))[0] as { status: string }).status;

  it('request is persisted and acked; input is redacted again server-side (safety net); session becomes awaiting_approval', async () => {
    const { p, reply } = await request({ toolInputRedacted: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" -d API_KEY=supersecretvalue1 https://x' });
    expect(reply.type).toBe('ack');
    const [row] = await tokenIn(p.approvalId);
    expect(row.status).toBe('pending');
    expect(row.tool_input_redacted).not.toContain('abcdefghijklmnop1234');
    expect(row.tool_input_redacted).not.toContain('supersecretvalue1');
    expect(row.tool_input_redacted).toContain('REDACTED');
    expect(await sessionStatus(a)).toBe('awaiting_approval');

    const list = ListApprovalsResponseSchema.parse((await http().get('/v1/approvals').set(bearer(readOnly.token)).expect(200)).body);
    const item = list.pending.find((x) => x.id === p.approvalId)!;
    expect(item).toMatchObject({ status: 'pending', toolName: 'Bash', claudeSessionId: 'ap-1', behavior: null, delivered: null });
    expect(item.projectName).toBe('commander');
    expect(JSON.stringify(item)).not.toContain('supersecretvalue1');
    const sessions = ListSessionsResponseV1Schema.parse((await http().get(`/v1/sessions?machine=${a.machineId}`).set(bearer(readOnly.token)).expect(200)).body);
    expect(sessions.items.find((s) => s.claudeSessionId === 'ap-1')).toMatchObject({ status: 'awaiting_approval', pendingApprovals: 1 });

    // tozalash: bekor qilamiz
    a.send(createEnvelope('approval.cancel', { approvalId: p.approvalId }));
    await a.nextOf('ack');
  });

  it('duplicate request (agent outbox retry) is idempotent; another machine cannot reuse the id', async () => {
    const { p } = await request();
    expect((await roundtrip(a, createEnvelope('approval.request', p))).type).toBe('ack');
    expect(await ds.query(`SELECT 1 FROM approvals WHERE id = $1`, [p.approvalId])).toHaveLength(1);

    const b = await newAgent('zz-approvals-b');
    const stolen = await roundtrip(b, createEnvelope('approval.request', p));
    expect(stolen).toMatchObject({ type: 'nack', payload: { code: 'invalid_payload', retriable: false } });
    expect((await tokenIn(p.approvalId))[0].status).toBe('pending');
    b.ws.close();
    a.send(createEnvelope('approval.cancel', { approvalId: p.approvalId }));
    await a.nextOf('ack');
  });

  it('allow: audit rows exist BEFORE the agent receives the decision; session returns to working; delivered recorded', async () => {
    const { p } = await request();
    const res = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200);
    const body = ApprovalDecisionResponseSchema.parse(res.body);
    expect(body).toMatchObject({ delivered: true, idempotent: false });
    expect(body.approval).toMatchObject({ status: 'approved', behavior: 'allow', decidedByDeviceId: approver.id, delivered: true });

    const dec = await a.nextOf('approval.decision');
    expect(dec.payload).toMatchObject({ approvalId: p.approvalId, behavior: 'allow' });
    expect(typeof dec.payload.decidedAt).toBe('number');
    expect(dec.payload.message).toBeUndefined();

    const audit = await ds.query(`SELECT action, details FROM audit_log WHERE target = $1 ORDER BY id`, [p.approvalId]);
    expect(audit.map((r: { action: string }) => r.action)).toEqual(['approval.decision', 'approval.decided']);
    expect(audit[1].details).toMatchObject({ behavior: 'allow', tool_name: 'Bash' });
    expect(JSON.stringify(audit)).not.toContain('npm test'); // tool kiritmasi auditga tushmaydi

    const [row] = await tokenIn(p.approvalId);
    expect(row).toMatchObject({ status: 'approved', decided_by_device_id: approver.id });
    expect(row.delivered_at).not.toBeNull();
    expect(await sessionStatus(a)).toBe('working');
  });

  it('deny with a message is delivered to the agent verbatim', async () => {
    const { p } = await request();
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny', message: 'Not on production' }).expect(200);
    const dec = await a.nextOf('approval.decision');
    expect(dec.payload).toMatchObject({ approvalId: p.approvalId, behavior: 'deny', message: 'Not on production' });
    expect((await tokenIn(p.approvalId))[0]).toMatchObject({ status: 'denied', decision_message: 'Not on production' });
  });

  it('first decision wins: conflicting decision and another device get 409; same device same decision is idempotent (no second dispatch, no second audit)', async () => {
    const { p } = await request();
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200);
    await a.nextOf('approval.decision');

    const conflict = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny' }).expect(409);
    expect(conflict.body).toMatchObject({ error: 'approval_conflict', status: 'approved' });
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver2.token)).send({ behavior: 'allow' }).expect(409);

    const again = ApprovalDecisionResponseSchema.parse((await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200)).body);
    expect(again).toMatchObject({ idempotent: true, delivered: true });
    expect(again.approval.status).toBe('approved');

    expect((await tokenIn(p.approvalId))[0].decided_by_device_id).toBe(approver.id);
    const decided = await ds.query(`SELECT 1 FROM audit_log WHERE target = $1 AND action = 'approval.decided'`, [p.approvalId]);
    expect(decided).toHaveLength(1);
    await a.expectNone('approval.decision', 300); // takroriy dispatch yo'q
  });

  it('concurrent opposite decisions: exactly one wins, the other is 409', async () => {
    const { p } = await request();
    const [r1, r2] = await Promise.all([
      http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }),
      http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver2.token)).send({ behavior: 'deny' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? 'allow' : 'deny';
    const dec = await a.nextOf('approval.decision');
    expect(dec.payload.behavior).toBe(winner);
    await a.expectNone('approval.decision', 300);
  });

  it('scope and validation: read-only token 403, no token 401, bad body 400, unknown id 404, malformed id 400', async () => {
    const { p } = await request();
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(readOnly.token)).send({ behavior: 'allow' }).expect(403);
    await http().post(`/v1/approvals/${p.approvalId}/decision`).send({ behavior: 'allow' }).expect(401);
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'always' }).expect(400);
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow', permissionSuggestions: [] }).expect(400);
    await http().post(`/v1/approvals/${randomUUID()}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(404);
    await http().post('/v1/approvals/xyz/decision').set(bearer(approver.token)).send({ behavior: 'allow' }).expect(400);
    expect((await tokenIn(p.approvalId))[0].status).toBe('pending');
    a.send(createEnvelope('approval.cancel', { approvalId: p.approvalId }));
    await a.nextOf('ack');
  });

  it('expiry: the sweeper marks it expired, tells the agent, and a late decision is refused (never an auto-allow)', async () => {
    const { p } = await request({ deadline: Date.now() + 400 });
    await sleep(600);
    expect(await svc(ApprovalsService).sweepExpired()).toBeGreaterThanOrEqual(1);
    const exp = await a.nextOf('approval.expired');
    expect(exp.payload.approvalId).toBe(p.approvalId);
    expect((await tokenIn(p.approvalId))[0].status).toBe('expired');
    expect(await sessionStatus(a)).toBe('waiting'); // lokal dialog hamon ochiq
    const res = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(409);
    expect(res.body.error).toBe('approval_conflict');
    expect(res.body.status).toBe('expired');
    await a.expectNone('approval.decision', 200);
  });

  it('a decision that races the sweeper after the deadline is 409 approval_expired and the agent is told', async () => {
    const { p } = await request({ deadline: Date.now() + 300 });
    await sleep(500); // deadline o'tdi, sweeper hali ishlamagan
    const res = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(409);
    expect(res.body.error).toBe('approval_expired');
    expect((await a.nextOf('approval.expired')).payload.approvalId).toBe(p.approvalId);
    expect((await tokenIn(p.approvalId))[0].status).toBe('expired');
    await a.expectNone('approval.decision', 200);
  });

  it('a request that is already past its deadline is stored as expired and answered with approval.expired', async () => {
    const { p, reply } = await request({ deadline: Date.now() - 1000 });
    expect(reply.type).toBe('ack');
    expect((await tokenIn(p.approvalId))[0].status).toBe('expired');
    expect((await a.nextOf('approval.expired')).payload.approvalId).toBe(p.approvalId);
  });

  it('a far-future deadline is capped by the center (max 15 minutes)', async () => {
    const { p } = await request({ deadline: Date.now() + 24 * 3_600_000 });
    const [row] = await ds.query(`SELECT deadline FROM approvals WHERE id = $1`, [p.approvalId]);
    expect(new Date(row.deadline).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);
    a.send(createEnvelope('approval.cancel', { approvalId: p.approvalId }));
    await a.nextOf('ack');
  });

  it('approval.cancel (resolved locally): cancelled, session restored, later decision 409, cancel of a decided approval is a no-op', async () => {
    const { p } = await request();
    expect(await sessionStatus(a)).toBe('awaiting_approval');
    const ack = await roundtrip(a, createEnvelope('approval.cancel', { approvalId: p.approvalId, reason: 'resolved_locally' }));
    expect(ack.type).toBe('ack');
    expect((await tokenIn(p.approvalId))[0].status).toBe('cancelled');
    expect(await sessionStatus(a)).toBe('working');
    const res = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(409);
    expect(res.body.status).toBe('cancelled');

    const { p: p2 } = await request();
    await http().post(`/v1/approvals/${p2.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny' }).expect(200);
    await a.nextOf('approval.decision');
    await roundtrip(a, createEnvelope('approval.cancel', { approvalId: p2.approvalId }));
    expect((await tokenIn(p2.approvalId))[0].status).toBe('denied'); // o'zgarmadi
    // noma'lum id: ack (idempotent), hech narsa o'zgarmaydi
    expect((await roundtrip(a, createEnvelope('approval.cancel', { approvalId: randomUUID() }))).type).toBe('ack');
  });

  it('two pending on one session: awaiting_approval stays until the LAST is resolved', async () => {
    const { p: p1 } = await request();
    const { p: p2 } = await request();
    await http().post(`/v1/approvals/${p1.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200);
    await a.nextOf('approval.decision');
    expect(await sessionStatus(a)).toBe('awaiting_approval');
    await http().post(`/v1/approvals/${p2.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny' }).expect(200);
    await a.nextOf('approval.decision');
    expect(await sessionStatus(a)).toBe('working');
  });

  it('agent offline at decision time: 200 delivered=false, redelivered on reconnect; the session is not left stale', async () => {
    const e = await enrollAgent('zz-offline');
    const off = await connectAgent(e);
    await roundtrip(off, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'off-1' })] }));
    const { p } = await request({ claudeSessionId: 'off-1' }, off);
    off.ws.close();
    await off.closed;
    await eventually(async () => ((await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]))[0] as { online: boolean }).online, (v) => v === false);

    const res = ApprovalDecisionResponseSchema.parse((await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny', message: 'later' }).expect(200)).body);
    expect(res).toMatchObject({ delivered: false, idempotent: false });
    expect(res.approval.delivered).toBe(false);

    const back = await connectAgent(e);
    const dec = await back.nextOf('approval.decision');
    expect(dec.payload).toMatchObject({ approvalId: p.approvalId, behavior: 'deny', message: 'later' });
    expect((await eventually(() => tokenIn(p.approvalId), (r) => r[0].delivered_at !== null))[0].delivered_at).not.toBeNull();
    back.ws.close();
  });

  it('flood protection: more than 50 pending approvals on one machine get a retriable rate_limited nack', async () => {
    const e = await enrollAgent('zz-flood');
    const f = await connectAgent(e);
    await ds.query(
      `INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline)
       SELECT gen_random_uuid(), $1, 'flood', '/x', 'Bash', '{}', repeat('b', 64), now() + interval '5 minutes' FROM generate_series(1, 50)`,
      [e.machineId],
    );
    const reply = await roundtrip(f, createEnvelope('approval.request', approvalReq({ claudeSessionId: 'flood' })));
    expect(reply).toMatchObject({ type: 'nack', payload: { code: 'rate_limited', retriable: true } });
    f.ws.close();
  });
});

describe('lockdown and approvals', () => {
  let approver: { id: string; token: string };
  let a: Agent;

  beforeAll(async () => {
    approver = await issueToken(['read', 'approve'], 'lockdown-approver');
    a = await newAgent('zz-lockdown');
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ld-1' })] }));
  });
  afterEach(async () => {
    await svc(LockdownService).set(false, 'test');
  });

  it('under lockdown: remote allow is refused (403, still pending); deny is accepted and delivered; reads still work; other mutations are blocked', async () => {
    const p = approvalReq({ claudeSessionId: 'ld-1' });
    await roundtrip(a, createEnvelope('approval.request', p));
    await svc(LockdownService).set(true, 'test');

    const refused = await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(403);
    expect(refused.body.error).toBe('lockdown');
    expect((await ds.query(`SELECT status FROM approvals WHERE id = $1`, [p.approvalId]))[0].status).toBe('pending');
    await a.expectNone('approval.decision', 200);

    await http().get('/v1/approvals').set(bearer(approver.token)).expect(200);
    await http().get('/v1/machines').set(bearer(approver.token)).expect(200);

    const denied = ApprovalDecisionResponseSchema.parse((await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'deny', message: 'lockdown' }).expect(200)).body);
    expect(denied.approval.status).toBe('denied');
    expect((await a.nextOf('approval.decision')).payload).toMatchObject({ approvalId: p.approvalId, behavior: 'deny' });
    const audit = await ds.query(`SELECT details FROM audit_log WHERE target = $1 AND action = 'approval.decided'`, [p.approvalId]);
    expect(audit[0].details).toMatchObject({ behavior: 'deny', lockdown: true });
  });

  it('allow after lockdown ends works again (the pending approval was untouched)', async () => {
    const p = approvalReq({ claudeSessionId: 'ld-1' });
    await roundtrip(a, createEnvelope('approval.request', p));
    await svc(LockdownService).set(true, 'test');
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(403);
    await svc(LockdownService).set(false, 'test');
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200);
    expect((await a.nextOf('approval.decision')).payload.behavior).toBe('allow');
  });

  it('an allow decided BEFORE lockdown but undelivered is held back on reconnect during lockdown (deny would be delivered)', async () => {
    const e = await enrollAgent('zz-lockdown-redeliver');
    const off = await connectAgent(e);
    await roundtrip(off, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ld-2' })] }));
    const p = approvalReq({ claudeSessionId: 'ld-2' });
    await roundtrip(off, createEnvelope('approval.request', p));
    off.ws.close();
    await off.closed;
    await eventually(async () => ((await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]))[0] as { online: boolean }).online, (v) => v === false);
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(approver.token)).send({ behavior: 'allow' }).expect(200);
    await svc(LockdownService).set(true, 'test');
    const back = await connectAgent(e);
    await back.expectNone('approval.decision', 400);
    expect((await ds.query(`SELECT delivered_at FROM approvals WHERE id = $1`, [p.approvalId]))[0].delivered_at).toBeNull();
    back.ws.close();
  });
});

describe('/ws/client', () => {
  let rd: { id: string; token: string };
  let appr: { id: string; token: string };
  let a: Agent;

  beforeAll(async () => {
    rd = await issueToken(['read'], 'ws-reader');
    appr = await issueToken(['read', 'approve'], 'ws-approver');
    a = await newAgent('zz-ws');
  });

  it('authenticates via Sec-WebSocket-Protocol (token not echoed) and via the first message', async () => {
    const c1 = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(rd.token));
    await c1.opened;
    expect(c1.ws.protocol).toBe(CLIENT_WS_SUBPROTOCOL);
    expect(c1.ws.protocol).not.toContain(rd.token);
    const ok = await c1.nextOf('auth.ok');
    expect(ok.payload).toMatchObject({ deviceId: rd.id, kind: 'web', scopes: ['read'], lockdown: { enabled: false } });
    c1.ws.close();
    const c2 = await connectClient(rd.token, 'message');
    c2.ws.close();
  });

  it('rejects: bad token, wrong scope, revoked token (4001); token in the query string is ignored (4002 timeout)', async () => {
    const bad = openSocket(CLIENT_WS_PATH, buildClientSubprotocols('cmdr_nottherealtoken'));
    await bad.opened;
    expect((await bad.nextOf('auth.error')).payload.code).toBe('unauthorized');
    expect(await bad.closed).toBe(CLIENT_WS_CLOSE.authFailed);

    const approveOnly = await issueToken(['approve'], 'ws-approve-only');
    const noScope = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(approveOnly.token));
    await noScope.opened;
    expect((await noScope.nextOf('auth.error')).payload.code).toBe('insufficient_scope');
    expect(await noScope.closed).toBe(CLIENT_WS_CLOSE.authFailed);

    const gone = await issueToken(['read'], 'ws-gone');
    await svc(DevicesService).revoke(gone.id, 'client', 'test');
    const revoked = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(gone.token));
    await revoked.opened;
    expect((await revoked.nextOf('auth.error')).payload.code).toBe('unauthorized');

    const q = new WebSocket(`ws://127.0.0.1:${port}${CLIENT_WS_PATH}?token=${rd.token}`);
    sockets.push(q);
    const closedCode = await new Promise<number>((resolve) => q.on('close', (code) => resolve(code)));
    expect(closedCode).toBe(CLIENT_WS_CLOSE.authTimeout);

    // legacy AUTH_TOKEN ham yaroqsiz
    const legacy = openSocket(CLIENT_WS_PATH);
    await legacy.opened;
    legacy.send(createEnvelope('auth', { token: LEGACY }));
    expect((await legacy.nextOf('auth.error')).payload.code).toBe('unauthorized');
  });

  it('failed websocket auth is audited without the token', async () => {
    svcAgg();
    const rows = await eventually(
      () => ds.query(`SELECT details FROM audit_log WHERE action = 'auth.failed' AND details->>'scheme' = 'ws-bearer'`),
      (r: unknown[]) => r.length >= 1,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows)).not.toContain('cmdr_nottherealtoken');
  });

  function svcAgg(): void {
    svc(FailureAggregator).flush(Date.now(), true);
  }

  it('subscribe -> session.updated after an agent event; unsubscribed channels receive nothing', async () => {
    const c = await connectClient(rd.token);
    await subscribe(c, ['sessions']);
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ws-s1', status: 'working' })] }));
    const upd = await c.nextWhere(sessionUpdate('ws-s1'), 3000, 'session.updated ws-s1');
    const session = SessionDtoSchema.parse(upd.payload.session);
    expect(session).toMatchObject({ claudeSessionId: 'ws-s1', status: 'working', machineId: a.machineId, projectName: 'commander' });

    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ws-s1', status: 'waiting', event: 'Notification', ts: Date.now() + 5 })] }));
    expect(SessionDtoSchema.parse((await c.nextWhere(sessionUpdate('ws-s1'), 3000, 'session.updated ws-s1')).payload.session).status).toBe('waiting');

    c.send(createEnvelope('unsubscribe', { channels: ['sessions'] }));
    await c.nextOf('subscribed');
    const before = c.all.filter((m) => m.type === 'session.updated').length;
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ws-s1', status: 'idle', ts: Date.now() + 10 })] }));
    await sleep(300);
    expect(c.all.filter((m) => m.type === 'session.updated').length).toBe(before);
    c.ws.close();
  });

  it('machine.updated on agent connect/disconnect, with stale sessions pushed too', async () => {
    const e = await enrollAgent('zz-presence');
    const c = await connectClient(rd.token);
    await subscribe(c, ['machines', 'sessions']);
    const ag = await connectAgent(e);
    const up = await c.nextWhere(machineUpdate(e.machineId), 3000, 'machine.updated (online)');
    expect(up.payload.machine).toMatchObject({ id: e.machineId, online: true });
    await roundtrip(ag, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'pres-1' })] }));
    await c.nextWhere(sessionUpdate('pres-1'), 3000, 'session.updated pres-1');
    ag.ws.close();
    const down = await c.nextWhere(machineUpdate(e.machineId), 3000, 'machine.updated (offline)');
    expect(down.payload.machine).toMatchObject({ id: e.machineId, online: false });
    const stale = await c.nextWhere(sessionUpdate('pres-1'), 3000, 'session.updated pres-1 (stale)');
    expect(SessionDtoSchema.parse(stale.payload.session).staleSince).not.toBeNull();
    c.ws.close();
  });

  it('usage.tick: bursts are aggregated and throttled (<= one tick per interval), sums are exact', async () => {
    const c = await connectClient(rd.token);
    await subscribe(c, ['usage']);
    const t = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await roundtrip(a, createEnvelope('agent.usage', { records: [usage({ requestId: `tick-${i}-${randomBytes(3).toString('hex')}`, inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.1, ts: t + i })] }));
    }
    await sleep(900);
    const ticks = c.all.filter((m) => m.type === 'usage.tick');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.length).toBeLessThanOrEqual(3);
    const total = ticks.reduce((s, m) => s + (m.payload.total as { requests: number }).requests, 0);
    const input = ticks.reduce((s, m) => s + (m.payload.total as { inputTokens: number }).inputTokens, 0);
    expect(total).toBe(5);
    expect(input).toBe(50);
    const first = ticks[0]!.payload as { byMachine: Array<{ machineId: string }>; byProject: Array<{ projectId: string | null }> };
    expect(first.byMachine.map((m) => m.machineId)).toContain(a.machineId);
    // dublikat usage tick tug'dirmaydi
    const dup = usage({ requestId: 'tick-dup', ts: t + 100 });
    await roundtrip(a, createEnvelope('agent.usage', { records: [dup] }));
    await sleep(500);
    const n1 = c.all.filter((m) => m.type === 'usage.tick').length;
    await roundtrip(a, createEnvelope('agent.usage', { records: [dup] }));
    await sleep(500);
    expect(c.all.filter((m) => m.type === 'usage.tick').length).toBe(n1);
    c.ws.close();
  });

  it('limits.updated is pushed with the computed snapshot when an agent reports limits', async () => {
    await ds.query(`DELETE FROM limit_samples`);
    const c = await connectClient(rd.token);
    await subscribe(c, ['limits']);
    const observedAt = Date.now();
    await roundtrip(a, createEnvelope('agent.limits', { observedAt, fiveHour: { usedPct: 61, resetsAt: observedAt + 3_600_000 }, claudeSessionId: 'ws-s1' }));
    const upd = await c.nextOf('limits.updated');
    const limits = LimitsResponseSchema.parse(upd.payload.limits);
    expect(limits.fiveHour).toMatchObject({ usedPct: 61, source: 'official', stale: false });
    expect(limits.sevenDay).toBeNull();
    c.ws.close();
  });

  it('approval.created / approval.resolved are pushed; approve over REST resolves for every subscriber', async () => {
    const c1 = await connectClient(rd.token);
    const c2 = await connectClient(appr.token);
    await subscribe(c1, ['approvals']);
    await subscribe(c2, ['approvals']);
    const p = approvalReq({ claudeSessionId: 'ws-s1' });
    await roundtrip(a, createEnvelope('approval.request', p));
    for (const c of [c1, c2]) {
      const created = await c.nextWhere(approvalPush('approval.created', p.approvalId), 3000, 'approval.created p');
      expect(created.payload.approval).toMatchObject({ id: p.approvalId, status: 'pending', toolName: 'Bash' });
    }
    await http().post(`/v1/approvals/${p.approvalId}/decision`).set(bearer(appr.token)).send({ behavior: 'allow' }).expect(200);
    for (const c of [c1, c2]) {
      const resolved = await c.nextWhere(approvalPush('approval.resolved', p.approvalId), 3000, 'approval.resolved p');
      expect(resolved.payload.approval).toMatchObject({ id: p.approvalId, status: 'approved', behavior: 'allow', decidedByDeviceId: appr.id });
    }
    await a.nextOf('approval.decision');
    // expiry va cancel ham approval.resolved
    const p2 = approvalReq({ claudeSessionId: 'ws-s1' });
    await roundtrip(a, createEnvelope('approval.request', p2));
    await c1.nextWhere(approvalPush('approval.created', p2.approvalId), 3000, 'approval.created p2');
    a.send(createEnvelope('approval.cancel', { approvalId: p2.approvalId }));
    expect((await c1.nextWhere(approvalPush('approval.resolved', p2.approvalId), 3000, 'approval.resolved p2')).payload.approval).toMatchObject({ id: p2.approvalId, status: 'cancelled' });
    const p3 = approvalReq({ claudeSessionId: 'ws-s1', deadline: Date.now() + 300 });
    await roundtrip(a, createEnvelope('approval.request', p3));
    await c1.nextWhere(approvalPush('approval.created', p3.approvalId), 3000, 'approval.created p3');
    await sleep(500);
    await svc(ApprovalsService).sweepExpired();
    expect((await c1.nextWhere(approvalPush('approval.resolved', p3.approvalId), 3000, 'approval.resolved p3')).payload.approval).toMatchObject({ id: p3.approvalId, status: 'expired' });
    c1.ws.close();
    c2.ws.close();
  });

  it('revoking a token disconnects its live websocket with 4010', async () => {
    const t = await issueToken(['read'], 'ws-live-revoke');
    const c = await connectClient(t.token);
    await subscribe(c, ['sessions']);
    await svc(DevicesService).revoke(t.id, 'client', 'test');
    expect(await Promise.race([c.closed, sleep(3000).then(() => -1)])).toBe(CLIENT_WS_CLOSE.revoked);
  });

  it('lockdown: websocket stays open (read-only), clients are told via lockdown.updated', async () => {
    const c = await connectClient(rd.token);
    await subscribe(c, ['sessions']);
    await sleep(250); // sweep birinchi holatni eslab olsin
    await svc(LockdownService).set(true, 'test');
    const on = await c.nextOf('lockdown.updated', 2000);
    expect(on.payload).toMatchObject({ enabled: true });
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 'ws-ld', status: 'working' })] }));
    // telemetriya/o'qish davom etadi; oldingi testlardan kechikkan session.updated kelishi mumkin — o'zimiznikini kutamiz
    const upd = await c.nextWhere(sessionUpdate('ws-ld'), 3000, 'session.updated ws-ld');
    expect(upd.payload.session).toMatchObject({ claudeSessionId: 'ws-ld' });
    const fresh = await connectClient(rd.token);
    expect((fresh.all.find((m) => m.type === 'auth.ok')!.payload.lockdown as { enabled: boolean }).enabled).toBe(true);
    fresh.ws.close();
    await svc(LockdownService).set(false, 'test');
    expect((await c.nextOf('lockdown.updated', 2000)).payload).toMatchObject({ enabled: false });
    c.ws.close();
  });

  it('protocol hygiene: unknown channel / type are errors, binary frame and garbage close the socket', async () => {
    const c = await connectClient(rd.token);
    c.send(createEnvelope('subscribe', { channels: ['secrets'] }));
    expect((await c.nextOf('error')).payload.code).toBe('invalid_message');
    c.send(createEnvelope('decision', { behavior: 'allow' }));
    expect((await c.nextOf('error')).payload.code).toBe('unknown_type');
    c.send(createEnvelope('ping', {}));
    expect((await c.nextOf('pong')).type).toBe('pong');
    c.ws.send('{not json');
    expect(await c.closed).toBe(CLIENT_WS_CLOSE.protocolError);
  });
});
