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
  CLIENT_WS_PATH,
  ListGroupsResponseSchema,
  ListMessagesResponseSchema,
  MessageDtoSchema,
  PEER_FRAME_HEADER,
  buildClientSubprotocols,
  buildAgentAuthString,
  createEnvelope,
} from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { MessagingModule } from '../../src/messaging/messaging.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 2.10 to'liq yo'l: haqiqiy `/ws/agent` (ikki agentd = ikki mashina), REST (scope/lockdown), `/ws/client` push, audit.
 * Sessiyalar `agent.events` bilan yaratiladi; ikkala loyiha bir `repo_key`ga bog'lanadi.
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

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, ProjectsModule, AgentModule, RealtimeModule, CommandsModule, MessagingModule,
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


const HOOK = (sid: string, event: string, cwd: string) => ({ eventId: randomUUID(), claudeSessionId: sid, event, status: 'working', cwd, ts: Date.now() });

async function mailbox(a: Agent, claudeSessionId: string, call: Record<string, unknown>): Promise<Msg> {
  const reqId = randomUUID();
  a.send(createEnvelope('mailbox.request', { reqId, claudeSessionId, call }));
  return a.nextWhere((m) => m.type === 'mailbox.reply' && m.payload.reqId === reqId, 5000, `mailbox.reply ${String(call['op'])}`);
}

const REPO = 'github.com/acme/e2e-water';
let srv: Agent;
let mac: Agent;
let readTok: { id: string; token: string };
let ctlTok: { id: string; token: string };
const SA = 'e2e-session-backend-aaaa';
const SB = 'e2e-session-frontend-bbbb';

describe('2.10: sessiyalararo xabar to\'liq yo\'l', () => {
  it('tayyorlash: ikki mashina, ikki sessiya (bir repo_key), tokenlar', async () => {
    srv = await newAgent('e2e-srv');
    mac = await newAgent('e2e-mac');
    const a = await roundtrip(srv, createEnvelope('agent.events', { events: [HOOK(SA, 'SessionStart', '/srv/water-api')] }));
    const b = await roundtrip(mac, createEnvelope('agent.events', { events: [HOOK(SB, 'SessionStart', '/Users/x/water-web')] }));
    expect(a.type).toBe('ack');
    expect(b.type).toBe('ack');
    await ds.query(`UPDATE projects SET repo_key = $1 WHERE path IN ('/srv/water-api', '/Users/x/water-web')`, [REPO]);
    readTok = await issue(['read']);
    ctlTok = await issue(['read', 'control']);
  });

  it('REST: guruh sukutda o\'chiq; scope va lockdown; o\'chiq guruhda agent rad etiladi', async () => {
    await http().get('/v1/messaging/groups').expect(401);
    const g1 = ListGroupsResponseSchema.parse((await http().get('/v1/messaging/groups').set(bearer(readTok.token)).expect(200)).body);
    const grp = g1.groups.find((g) => g.key === REPO)!;
    expect(grp).toMatchObject({ enabled: false, autoWake: false, telegramQuestions: false });
    expect(grp.members.map((m) => m.role).sort()).toEqual(['backend', 'frontend']);

    await http().patch('/v1/messaging/groups').set(bearer(readTok.token)).send({ key: REPO, enabled: true }).expect(403);
    const closed = await mailbox(srv, SA, { op: 'send', to: 'frontend', kind: 'question', subject: 's', body: 'b' });
    expect(closed.payload).toMatchObject({ ok: false, error: { code: 'messaging_disabled' } });

    await svc(LockdownService).set(true, 'test');
    try {
      await http().patch('/v1/messaging/groups').set(bearer(ctlTok.token)).send({ key: REPO, enabled: true }).expect(403);
      await http().get('/v1/messaging/groups').set(bearer(readTok.token)).expect(200); // o'qish ishlaydi
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    await http().patch('/v1/messaging/groups').set(bearer(ctlTok.token)).send({ key: REPO, enabled: true, bogus: 1 }).expect(400); // strict
    const on = await http().patch('/v1/messaging/groups').set(bearer(ctlTok.token)).send({ key: REPO, enabled: true }).expect(200);
    expect(on.body.enabled).toBe(true);
    await http().patch('/v1/messaging/groups').set(bearer(ctlTok.token)).send({ key: 'no/such', enabled: true }).expect(404);
  });

  it('agent -> agent: send, /ws/client push, deliver (ramka), audit matnsiz', async () => {
    const client = openSocket(CLIENT_WS_PATH);
    await client.opened;
    client.send(createEnvelope('auth', { token: readTok.token }));
    await client.nextOf('auth.ok');
    client.send(createEnvelope('subscribe', { channels: ['messages'] }));
    await client.nextOf('subscribed');

    const sent = await mailbox(srv, SA, { op: 'send', to: 'frontend', kind: 'api_change', subject: 'GET /users', body: 'sahifalash: limit va cursor; token=ZZsecret12345' });
    expect(sent.payload).toMatchObject({ ok: true, data: { recipients: 1, target: 'role:frontend' } });
    // boshqa testlar/sweep'lardan kechikkan message.* push'lari bo'lishi mumkin: aynan shu xabarni kutamiz (6.19)
    const created = await client.nextWhere((m) => m.type === 'message.created' && (m.payload.message as { subject?: string }).subject === 'GET /users', 3000, 'message.created GET /users');
    const dto = MessageDtoSchema.parse((created.payload as { message: unknown }).message);
    expect(dto).toMatchObject({ kind: 'api_change', fromRole: 'backend', status: 'pending', groupKey: REPO });
    expect(dto.body).not.toContain('ZZsecret12345');

    const del = await mailbox(mac, SB, { op: 'deliver' });
    const data = del.payload.data as { text: string; count: number };
    expect(data.count).toBe(1);
    expect(data.text).toContain(PEER_FRAME_HEADER);
    const upd = await client.nextWhere((m) => m.type === 'message.updated' && (m.payload.message as { id?: string }).id === dto.id, 3000, 'message.updated (shu xabar)');
    expect((upd.payload as { message: { status: string } }).message.status).toBe('delivered');
    expect((await mailbox(mac, SB, { op: 'deliver' })).payload.data).toMatchObject({ count: 0, text: null });

    const audit: Array<{ actor_kind: string; details: Record<string, unknown> }> = await ds.query(`SELECT actor_kind, details FROM audit_log WHERE action = 'message.send' AND target = $1`, [REPO]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_kind).toBe('agentd');
    expect(JSON.stringify(audit[0]!.details)).not.toContain('limit va cursor');
  });

  it('REST: egasi yuboradi (201), xabarlar ro\'yxati, rol/context/rules/link (audit), o\'chirilganda 409', async () => {
    const owner = await http().post('/v1/messaging/messages').set(bearer(ctlTok.token)).send({ key: REPO, to: 'backend', kind: 'request', subject: 'Status', body: 'ish holati?' }).expect(201);
    expect(owner.body.recipients).toBe(1);
    const list = ListMessagesResponseSchema.parse((await http().get('/v1/messaging/messages').query({ key: REPO }).set(bearer(readTok.token)).expect(200)).body);
    expect(list.items.map((m) => m.fromRole)).toEqual(['owner', 'backend']);
    expect(ListMessagesResponseSchema.parse((await http().get('/v1/messaging/messages').query({ key: 'other/group' }).set(bearer(readTok.token)).expect(200)).body).items).toEqual([]);
    await http().post('/v1/messaging/messages').set(bearer(readTok.token)).send({ key: REPO, to: 'backend', kind: 'info', subject: 'a', body: 'b' }).expect(403);

    await http().put('/v1/messaging/groups/context').set(bearer(ctlTok.token)).send({ key: REPO, context: 'API v1\npassword=Hunter2Hunter2' }).expect(200);
    const ctx = await mailbox(mac, SB, { op: 'context' });
    expect((ctx.payload.data as { context: string }).context).toContain('API v1');
    expect((ctx.payload.data as { context: string }).context).not.toContain('Hunter2Hunter2');
    await http().put('/v1/messaging/groups/rules').set(bearer(ctlTok.token)).send({ key: REPO, rules: [{ kind: 'question', toRole: 'backend' }] }).expect(200);
    await http().put('/v1/messaging/groups/rules').set(bearer(ctlTok.token)).send({ key: REPO, rules: [{ toRole: 'owner' }] }).expect(400);

    const groups = ListGroupsResponseSchema.parse((await http().get('/v1/messaging/groups').set(bearer(readTok.token)).expect(200)).body);
    const sidA = groups.groups.find((g) => g.key === REPO)!.members.find((m) => m.role === 'backend')!.sessionId;
    const role = await http().put(`/v1/messaging/sessions/${sidA}/role`).set(bearer(ctlTok.token)).send({ role: 'api' }).expect(200);
    expect(role.body).toMatchObject({ role: 'api', roleSource: 'owner' });
    expect((await mailbox(srv, SA, { op: 'set_role', role: 'x' })).payload).toMatchObject({ ok: false, error: { code: 'forbidden_role' } });

    await http().put('/v1/messaging/links').set(bearer(ctlTok.token)).send({ baseKey: REPO, workspace: 'e2e-ws' }).expect(200);
    const linked = ListGroupsResponseSchema.parse((await http().get('/v1/messaging/groups').set(bearer(readTok.token)).expect(200)).body);
    expect(linked.groups.find((g) => g.key === 'workspace:e2e-ws')?.members).toHaveLength(2);
    // yangi guruh (workspace) sukutda o'chiq: eski guruh sozlamasi ko'chmaydi (xavfsizroq)
    expect(linked.groups.find((g) => g.key === 'workspace:e2e-ws')?.enabled).toBe(false);
    expect((await mailbox(srv, SA, { op: 'peers' })).payload).toMatchObject({ ok: false, error: { code: 'messaging_disabled' } });
    await http().post('/v1/messaging/messages').set(bearer(ctlTok.token)).send({ key: 'workspace:e2e-ws', to: 'all', kind: 'info', subject: 'a', body: 'b' }).expect(409);
    await http().delete('/v1/messaging/links').query({ baseKey: REPO }).set(bearer(ctlTok.token)).expect(200);

    const acts: Array<{ action: string }> = await ds.query(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'messaging.%' OR action = 'message.send'`);
    expect(acts.map((a) => a.action).sort()).toEqual(['message.send', 'messaging.context.update', 'messaging.group.update', 'messaging.link.delete', 'messaging.link.put', 'messaging.role.set', 'messaging.rules.update']);
  });

  it('global kill-switch: REST orqali o\'chirilsa hamma guruhda to\'xtaydi', async () => {
    await http().put('/v1/messaging/settings').set(bearer(ctlTok.token)).send({ enabled: false }).expect(200);
    expect((await mailbox(srv, SA, { op: 'send', to: 'frontend', kind: 'info', subject: 's', body: 'b' })).payload).toMatchObject({ ok: false, error: { code: 'messaging_disabled' } });
    expect((await mailbox(mac, SB, { op: 'deliver' })).payload).toMatchObject({ ok: true, data: { count: 0 } });
    await http().put('/v1/messaging/settings').set(bearer(ctlTok.token)).send({ enabled: true }).expect(200);
    expect((await http().get('/v1/messaging/settings').set(bearer(readTok.token)).expect(200)).body).toEqual({ enabled: true });
  });
});
