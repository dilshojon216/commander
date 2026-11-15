import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { AGENT_WS_PATH, LogsReadResponseSchema, buildAgentAuthString, buildCommandSigString, createEnvelope } from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import { hashCommandPayload } from '../../src/commands/command-signer.js';
import { StepUpRegistry } from '../../src/commands/step-up.js';
import { MIGRATIONS, typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { InvestigationsModule } from '../../src/investigations/investigations.module.js';
import { InvestigationsTelegram } from '../../src/investigations/investigations-telegram.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { LogsModule } from '../../src/logs/logs.module.js';
import { LogsRelayService } from '../../src/logs/logs-relay.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 6.6 log ko'ruvchi + 6.4 hodisadan tekshiruv: haqiqiy TimescaleDB + haqiqiy `ws` (soxta agent) + haqiqiy Ed25519 imzo.
 * Telegram o'rniga soxta step-up kanali. Log matni hech qaysi jadvalga tushmasligi tekshiriladi.
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Agent {
  ws: WebSocket;
  all: Msg[];
  send: (m: unknown) => void;
  nextOf: (type: string, ms?: number) => Promise<Msg>;
  expectNone: (type: string, ms?: number) => Promise<void>;
  deviceId: string;
  machineId: string;
  centerKey: string;
}

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
let stepUpAvailable = true;
const stepUpRequests: string[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, LogsModule, InvestigationsModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 30_000, revokeCheckIntervalMs: 100 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'session.start': [1000, 60_000], 'logs.tail': [1000, 60_000] } })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  port = (app.getHttpServer().address() as AddressInfo).port;
  app.get(StepUpRegistry).register({
    isAvailable: async () => stepUpAvailable,
    request: async (c) => {
      stepUpRequests.push(c.id);
      return stepUpAvailable ? 1 : 0;
    },
  });
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

function openAgentSocket(): { ws: WebSocket; all: Msg[]; opened: Promise<void>; send: (m: unknown) => void; nextOf: Agent['nextOf']; expectNone: Agent['expectNone'] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);
  sockets.push(ws);
  const inbox: Msg[] = [];
  const all: Msg[] = [];
  const waiters: Array<{ match: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    all.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const nextOf = (type: string, ms = 3000): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      waiters.push({ match: (m) => m.type === type, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  return {
    ws, all, nextOf,
    send: (m) => ws.send(JSON.stringify(m)),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    expectNone: async (type, ms = 400) => {
      const start = all.length;
      await sleep(ms);
      expect(all.slice(start).filter((m) => m.type === type)).toHaveLength(0);
    },
  };
}

const CONTROL = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, logs: true, allowLogs: true, allowedLogRootCount: 0 };

async function newAgent(name: string, control: Record<string, unknown> | null = CONTROL): Promise<Agent> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ format: 'jwk' }).x as string;
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: pubB64, hardware_id: `hw-li-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const deviceId = res.body.device_id as string;
  const machineId = res.body.machine_id as string;
  const c = openAgentSocket();
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId }), 'utf8'), privateKey as KeyObject).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', hostname: `${name}-host`, os: 'linux' }));
  await c.nextOf('auth.ok');
  if (control) {
    c.send(createEnvelope('agent.heartbeat', { control }));
    await eventually(async () => (await ds.query(`SELECT control FROM machines WHERE id = $1`, [machineId]))[0].control, (v) => v !== null);
  }
  return { ...c, deviceId, machineId, centerKey: res.body.center_public_key as string };
}

async function issueToken(scopes: string[], kind: 'web' | 'telegram' = 'web'): Promise<{ id: string; token: string }> {
  const t = await svc(ClientTokensService).issue({ kind, name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
}

function verifyDispatch(centerKey: string, deviceId: string, m: Msg): boolean {
  const p = m.payload as { commandId: string; type: 'logs.tail'; nonce: string; expiresAt: number; sig: string; payload: unknown };
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: centerKey }, format: 'jwk' });
  return verify(null, Buffer.from(buildCommandSigString({ deviceId, commandId: p.commandId, type: p.type, nonce: p.nonce, expiresAt: p.expiresAt, payloadSha256: hashCommandPayload(p.payload) }), 'utf8'), pub, Buffer.from(p.sig, 'base64url'));
}

const statusOf = async (id: string): Promise<{ status: string; error_code: string | null }> => (await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [id]))[0];
const postLogs = (token: string, machineId: string, body: unknown) => http().post(`/v1/machines/${machineId}/logs`).set(bearer(token)).send(body as object);
const getLogs = (token: string, id: string, after = 0) => http().get(`/v1/logs/${id}?after=${after}`).set(bearer(token));
const SECRET = 'ghp_' + 'Z'.repeat(30);

describe('migratsiya 6.4/6.6', () => {
  it('chk_commands_type ga logs.tail qo\'shilgan (boshqa turlar saqlanadi); down faqat o\'zinikini olib tashlaydi, up qayta tiklaydi', async () => {
    const own = await createThrowawayDb();
    const { openDataSource } = await import('./helpers.js');
    const d = await openDataSource(own.url);
    try {
      await d.runMigrations();
      const typesOf = async (): Promise<string[]> => {
        const [r] = await d.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`);
        return [...(r.def as string).matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!);
      };
      const before = await typesOf();
      expect(before).toEqual(expect.arrayContaining(['logs.tail', 'session.start', 'project.diff', 'config.apply']));
      expect(await d.query(`SELECT to_regclass('incident_investigations') AS t`)).toEqual([{ t: 'incident_investigations' }]);
      const latest = async (): Promise<string> => (await d.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`))[0].name as string;
      let guard = 0;
      while ((await latest()) !== 'LogsInvestigations1731407100000' && guard++ < MIGRATIONS.length) await d.undoLastMigration();
      await d.undoLastMigration();
      const after = await typesOf();
      expect(after).not.toContain('logs.tail');
      expect(after).toContain('session.start');
      expect(await d.query(`SELECT to_regclass('incident_investigations') AS t`)).toEqual([{ t: null }]);
      await d.runMigrations();
      expect(await typesOf()).toContain('logs.tail');
    } finally {
      await d.destroy();
      await own.drop();
    }
  });
});

describe('logs.tail: imzolangan, faqat o\'qish, matn saqlanmaydi', () => {
  it('to\'liq oqim: POST -> imzolangan dispatch (step-up YO\'Q) -> ack -> chunk\'lar -> cursor bilan o\'qish -> done; DB\'da log matni YO\'Q', async () => {
    const a = await newAgent('zz-logs-flow');
    const c = await issueToken(['read', 'control']);
    const before = stepUpRequests.length;

    const res = await postLogs(c.token, a.machineId, { source: 'docker', name: 'web-1', lines: 50 }).expect(201);
    const cmd = res.body.command as { id: string; status: string; type: string; promptPreview: string };
    expect(cmd).toMatchObject({ type: 'logs.tail', status: 'sent', stepUp: { required: false } });
    expect(stepUpRequests.length).toBe(before); // faqat o'qish: ikkinchi tasdiq YO'Q
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ commandId: cmd.id, type: 'logs.tail', payload: { source: 'docker', name: 'web-1', lines: 50 } });
    expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
    expect(cmd.promptPreview).toContain('docker: web-1');

    a.send(createEnvelope('command.ack', { commandId: cmd.id }));
    await eventually(() => statusOf(cmd.id), (r) => r.status === 'acked');
    a.send(createEnvelope('logs.chunk', { commandId: cmd.id, seq: 0, lines: ['boot ok', `Authorization: Bearer ${SECRET} x`, `token=${SECRET}`] }));
    const r1 = LogsReadResponseSchema.parse((await eventually(async () => (await getLogs(c.token, cmd.id)).body, (b: { lines: string[] }) => b.lines.length >= 3)));
    expect(r1).toMatchObject({ state: 'live', nextSeq: 3 });
    expect(r1.lines[0]).toBe('boot ok');
    expect(r1.lines.join('\n')).not.toContain('ZZZZZZZZZ'); // markaz qayta redakt qiladi

    a.send(createEnvelope('logs.chunk', { commandId: cmd.id, seq: 1, lines: ['more'], dropped: 5, done: true, reason: 'complete' }));
    a.send(createEnvelope('command.result', { commandId: cmd.id, state: 'done', result: { detail: '4 lines' } }));
    await eventually(() => statusOf(cmd.id), (r) => r.status === 'done');
    const r2 = LogsReadResponseSchema.parse((await getLogs(c.token, cmd.id, r1.nextSeq).expect(200)).body);
    expect(r2).toMatchObject({ state: 'done', reason: 'complete', lines: ['more'], dropped: 5 });
    expect((await getLogs(c.token, cmd.id).expect(200)).headers['cache-control']).toContain('no-store');

    // MAXFIYLIK: hech qaysi jadvalda log matni yo'q
    const dump = JSON.stringify({
      commands: await ds.query(`SELECT payload, result, error_message FROM commands WHERE id = $1`, [cmd.id]),
      audit: await ds.query(`SELECT details FROM audit_log WHERE target = $1 OR details::text LIKE $2`, [cmd.id, '%web-1%']),
    });
    expect(dump).not.toContain('boot ok');
    expect(dump).not.toContain('more');
    expect(dump).not.toContain(SECRET);
    const created = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [cmd.id]);
    expect(created[0].details).toMatchObject({ type: 'logs.tail', source: 'docker', name: 'web-1', lines: 50, follow: false });
  });

  it('follow: DELETE -> agentga logs.stop; idle o\'quvchi (sweep) ham to\'xtatadi; boshqa turdagi buyruq 404', async () => {
    const a = await newAgent('zz-logs-follow');
    const c = await issueToken(['read', 'control']);
    const res = await postLogs(c.token, a.machineId, { source: 'journal', name: 'nginx', lines: 10, follow: true, since: '10m' }).expect(201);
    const id = res.body.command.id as string;
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ payload: { source: 'journal', name: 'nginx', follow: true, since: '10m' } });
    a.send(createEnvelope('command.ack', { commandId: id }));
    a.send(createEnvelope('command.result', { commandId: id, state: 'done', result: { detail: 'follow started' } }));
    a.send(createEnvelope('logs.chunk', { commandId: id, seq: 0, lines: ['a'] }));
    await eventually(async () => (await getLogs(c.token, id)).body.lines as string[], (l) => l.length === 1);
    await http().delete(`/v1/logs/${id}`).set(bearer(c.token)).expect(200).expect({ stopped: true });
    const stop = await a.nextOf('logs.stop');
    expect(stop.payload).toEqual({ commandId: id });
    expect((await getLogs(c.token, id)).body).toMatchObject({ state: 'done', reason: 'stopped' });

    const res2 = await postLogs(c.token, a.machineId, { source: 'docker', name: 'x', lines: 5, follow: true }).expect(201);
    await a.nextOf('command.dispatch');
    svc(LogsRelayService).sweep(Date.now() + 31_000);
    expect((await a.nextOf('logs.stop')).payload).toEqual({ commandId: res2.body.command.id });

    const other = await http().post('/v1/commands').set(bearer(c.token)).send({ type: 'session.start', machineId: a.machineId, cwd: '/x', prompt: 'p', permissionMode: 'plan' });
    expect([200, 201]).toContain(other.status);
    await http().get(`/v1/logs/${other.body.command.id}`).set(bearer(c.token)).expect(404);
  });

  it('scope: read tokeni boshlay olmaydi (403), o\'qiy oladi; tokensiz 401; yomon tana 400 (qator yozilmaydi)', async () => {
    const a = await newAgent('zz-logs-scope');
    const ro = await issueToken(['read']);
    await postLogs(ro.token, a.machineId, { source: 'docker', name: 'web', lines: 5 }).expect(403);
    await http().post(`/v1/machines/${a.machineId}/logs`).send({ source: 'docker', name: 'web', lines: 5 }).expect(401);
    const c = await issueToken(['read', 'control']);
    const n0 = (await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'logs.tail'`))[0].n as number;
    for (const body of [
      { source: 'docker', name: '--follow', lines: 5 },
      { source: 'docker', name: 'a b', lines: 5 },
      { source: 'docker', name: 'x;id', lines: 5 },
      { source: 'file', name: 'relative.log', lines: 5 },
      { source: 'file', name: '/var/log/../etc/shadow', lines: 5 },
      { source: 'docker', name: 'web', lines: 5000 },
      { source: 'docker', name: 'web', lines: 5, since: 'yesterday' },
      { source: 'docker', name: 'web', lines: 5, extra: true },
      { source: 'nope', name: 'web', lines: 5 },
    ]) await postLogs(c.token, a.machineId, body).expect(400);
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'logs.tail'`))[0].n).toBe(n0);
    // read bilan boshqa mashina/yo'q buyruq o'qish: 404
    await getLogs(ro.token, randomUUID()).expect(404);
  });

  it('eski agent (logs e\'lon qilmagan): rejected(agent_outdated); allowLogs=false: rejected(action_not_allowed); offline: machine_offline; dispatch YO\'Q', async () => {
    const c = await issueToken(['read', 'control']);
    const old = await newAgent('zz-logs-old', { ...CONTROL, logs: undefined, allowLogs: undefined });
    const off = await newAgent('zz-logs-off', { ...CONTROL, allowLogs: false });
    const r1 = await postLogs(c.token, old.machineId, { source: 'docker', name: 'web', lines: 5 }).expect(201);
    expect(r1.body.command).toMatchObject({ status: 'rejected', errorCode: 'agent_outdated' });
    const r2 = await postLogs(c.token, off.machineId, { source: 'docker', name: 'web', lines: 5 }).expect(201);
    expect(r2.body.command).toMatchObject({ status: 'rejected', errorCode: 'action_not_allowed' });
    await old.expectNone('command.dispatch');
    await off.expectNone('command.dispatch');
    expect((await getLogs(c.token, r2.body.command.id)).body).toMatchObject({ state: 'error', error: { code: 'action_not_allowed' } });
    off.ws.close();
    await eventually(async () => (await ds.query(`SELECT online FROM machines WHERE id = $1`, [off.machineId]))[0].online, (v) => v === false);
    const r3 = await postLogs(c.token, off.machineId, { source: 'docker', name: 'web', lines: 5 }).expect(201);
    expect(r3.body.command).toMatchObject({ status: 'rejected', errorCode: 'machine_offline' });
  });

  it('agent rad etdi (logs_not_found): buyruq rejected/failed, o\'qish xatoni ko\'rsatadi', async () => {
    const a = await newAgent('zz-logs-nf');
    const c = await issueToken(['read', 'control']);
    const res = await postLogs(c.token, a.machineId, { source: 'docker', name: 'nope', lines: 5 }).expect(201);
    await a.nextOf('command.dispatch');
    a.send(createEnvelope('command.ack', { commandId: res.body.command.id }));
    a.send(createEnvelope('command.result', { commandId: res.body.command.id, state: 'failed', error: { code: 'logs_not_found', message: 'No such container on this machine' } }));
    a.send(createEnvelope('logs.chunk', { commandId: res.body.command.id, seq: 0, lines: [], done: true, reason: 'error', error: { code: 'logs_not_found', message: 'No such container on this machine' } }));
    const r = await eventually(async () => (await getLogs(c.token, res.body.command.id)).body, (b: { state: string }) => b.state === 'error');
    expect(r).toMatchObject({ state: 'error', error: { code: 'logs_not_found' } });
  });

  it('begona mashinaning chunk\'i e\'tiborsiz (boshqa oqim buferiga yozolmaydi)', async () => {
    const a = await newAgent('zz-logs-own-a');
    const b = await newAgent('zz-logs-own-b');
    const c = await issueToken(['read', 'control']);
    const res = await postLogs(c.token, a.machineId, { source: 'docker', name: 'web', lines: 5, follow: true }).expect(201);
    await a.nextOf('command.dispatch');
    b.send(createEnvelope('logs.chunk', { commandId: res.body.command.id, seq: 0, lines: ['FORGED'] }));
    await sleep(200);
    a.send(createEnvelope('logs.chunk', { commandId: res.body.command.id, seq: 0, lines: ['real'] }));
    const r = await eventually(async () => (await getLogs(c.token, res.body.command.id)).body.lines as string[], (l) => l.length > 0);
    expect(r).toEqual(['real']);
  });
});

// --- 6.4 ----------------------------------------------------------------------------------------

async function seedIncident(machineId: string, kind = 'disk', subject = '/'): Promise<string> {
  const [r] = await ds.query(`INSERT INTO health_incidents (machine_id, kind, subject, severity, summary) VALUES ($1, $2, $3, 'critical', $4) RETURNING id`, [machineId, kind, subject, `Disk / 95% to'la token=${SECRET}`]);
  return r.id as string;
}
const putSettings = (token: string, body: unknown) => http().put('/v1/investigations/settings').set(bearer(token)).send(body as object);
const investigate = (token: string, body: unknown) => http().post('/v1/investigations').set(bearer(token)).send(body as object);

describe('hodisadan tekshiruv (6.4)', () => {
  it('sozlanmagan ops papka: 409 ops_folder_not_configured (tushuntirish bilan), buyruq yaratilmaydi', async () => {
    const a = await newAgent('zz-inv-nofolder');
    const c = await issueToken(['read', 'control']);
    const inc = await seedIncident(a.machineId);
    const n0 = (await ds.query(`SELECT count(*)::int AS n FROM commands`))[0].n as number;
    const res = await investigate(c.token, { kind: 'health', id: inc }).expect(409);
    expect(res.body).toMatchObject({ error: 'ops_folder_not_configured' });
    expect(String(res.body.message)).toContain('mkdir');
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands`))[0].n).toBe(n0);
    await investigate(c.token, { kind: 'health', id: randomUUID() }).expect(404);
    await investigate(c.token, { kind: 'bogus', id: inc }).expect(400);
  });

  it('dashboard yo\'li: plan rejimi, step-up (Telegram) -> tasdiq -> imzolangan dispatch; redakt prompt; sessiya ochilgach hodisa bilan bog\'liq; tugagach finished', async () => {
    const a = await newAgent('zz-inv-flow');
    const c = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    const inc = await seedIncident(a.machineId);
    await putSettings(c.token, { opsFolders: { [a.machineId]: '/Users/x/working/ops-notes' } }).expect(200);
    expect((await http().get('/v1/investigations/settings').set(bearer(c.token)).expect(200)).body).toMatchObject({ model: 'sonnet', opsFolders: { [a.machineId]: '/Users/x/working/ops-notes' } });
    await putSettings(c.token, { opsFolders: { [a.machineId]: 'relative' } }).expect(400);

    const res = await investigate(c.token, { kind: 'health', id: inc }).expect(201);
    const cmd = res.body.command as { id: string; status: string; permissionMode: string; cwd: string; model: string };
    expect(cmd).toMatchObject({ status: 'awaiting_confirmation', permissionMode: 'plan', cwd: '/Users/x/working/ops-notes', model: 'sonnet' });
    expect(res.body.investigation).toMatchObject({ subjectKind: 'health', subjectId: inc, state: 'awaiting_confirmation', machineId: a.machineId });
    // o'z promptimiz dashboard-majburiy ko'rib chiqishni talab qilmaydi (aks holda Telegram tasdig'i ishlamasdi)
    expect((res.body.command as { review?: { required: boolean } }).review?.required ?? false).toBe(false);
    expect(stepUpRequests.at(-1)).toBe(cmd.id);
    await a.expectNone('command.dispatch', 300);
    expect(JSON.stringify(await ds.query(`SELECT payload FROM commands WHERE id = $1`, [cmd.id]))).not.toContain(SECRET);

    // faol tekshiruv bor: ikkinchisi 409
    expect((await investigate(c.token, { kind: 'health', id: inc }).expect(409)).body).toMatchObject({ error: 'already_investigating' });

    expect((await svc(CommandsService).confirm(cmd.id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null })).outcome).toBe('confirmed');
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ commandId: cmd.id, type: 'session.start', payload: { cwd: '/Users/x/working/ops-notes', permissionMode: 'plan', model: 'sonnet' } });
    const prompt = (d.payload.payload as { prompt: string }).prompt;
    expect(prompt).toContain('Hodisa tekshiruvi');
    expect(prompt).toContain("O'ZGARTIRMA");
    expect(prompt).not.toContain(SECRET); // agentga ham redakt qilingan matn boradi
    expect(prompt.length).toBeLessThanOrEqual(6100);

    a.send(createEnvelope('command.ack', { commandId: cmd.id }));
    const claudeSessionId = `inv-${randomBytes(3).toString('hex')}`;
    a.send(createEnvelope('command.result', { commandId: cmd.id, state: 'done', result: { claudeSessionId, shortId: 'abcd1234' } }));
    const list = await eventually(async () => (await http().get(`/v1/investigations?subjectId=${inc}`).set(bearer(c.token)).expect(200)).body.items as Array<{ state: string; sessionId: string | null }>, (items) => items[0]?.state === 'running');
    expect(list[0]).toMatchObject({ state: 'running', subjectKind: 'health', subjectId: inc });
    expect(list[0]!.sessionId).toBeTruthy();

    await ds.query(`UPDATE sessions SET status = 'done', ended_at = now() WHERE id = $1`, [list[0]!.sessionId]);
    const fin = (await http().get(`/v1/investigations/${(list[0] as unknown as { id: string }).id}`).set(bearer(c.token)).expect(200)).body;
    expect(fin).toMatchObject({ state: 'finished', sessionStatus: 'done' });
    expect(fin.endedAt).toBeTruthy();

    const audit = (await ds.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY id`, [cmd.id])).map((r: { action: string }) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['command.created', 'investigation.requested', 'command.confirmed', 'command.dispatched']));
    // tugagan tekshiruvdan keyin yangisi ochilishi mumkin
    await investigate(c.token, { kind: 'health', id: inc }).expect(201);
  });

  it('Telegram inline yo\'li: ikkinchi step-up so\'rovi YO\'Q, darhol dispatch, audit confirmation=telegram_inline; agent cwd rad etsa holat failed + tushuntirish', async () => {
    const a = await newAgent('zz-inv-tg');
    const c = await issueToken(['read', 'control']);
    const tg = await issueToken(['read', 'control', 'approve'], 'telegram');
    const inc = await seedIncident(a.machineId, 'memory', '');
    await putSettings(c.token, { opsFolders: { [a.machineId]: '/ops/not-created' }, model: 'haiku' }).expect(200);
    const before = stepUpRequests.length;

    const startP = svc(InvestigationsTelegram).start('health', inc, tg.id, 5000);
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'session.start', payload: { permissionMode: 'plan', model: 'haiku', cwd: '/ops/not-created' } });
    expect(stepUpRequests.length).toBe(before);
    a.send(createEnvelope('command.ack', { commandId: d.payload.commandId }));
    a.send(createEnvelope('command.result', { commandId: d.payload.commandId, state: 'rejected', error: { code: 'cwd_invalid', message: 'cwd does not exist' } }));
    const out = await startP;
    expect(out.ok).toBe(false);
    expect(out.text).toContain('mavjud emas');
    expect(out.text).toContain('/ops/not-created');
    const [row] = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [d.payload.commandId]);
    expect(row.details).toMatchObject({ confirmation: 'telegram_inline', type: 'session.start' });
    const list = (await http().get(`/v1/investigations?machineId=${a.machineId}`).set(bearer(c.token)).expect(200)).body.items as Array<{ state: string; errorCode: string }>;
    expect(list[0]).toMatchObject({ state: 'failed', errorCode: 'cwd_invalid' });
    // preview: hodisa tiklanmaguncha qayta urinish mumkin (failed faol emas)
    expect((await svc(InvestigationsTelegram).preview('health', inc)).ok).toBe(true);
  });

  it('watchdog ogohlantirishi: ta\'sirlangan mashinada (sessiya mashinasi) ochiladi', async () => {
    const a = await newAgent('zz-inv-wd');
    const c = await issueToken(['read', 'control']);
    const [s] = await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, cwd, project, status, started_at, status_since, last_seen_at) VALUES ($1, 'wd-s', '/x', 'x', 'working', now(), now(), now()) RETURNING id`, [a.machineId]);
    const [al] = await ds.query(`INSERT INTO watchdog_alerts (kind, session_id, machine_id, title, detail, payload, episode_key) VALUES ('error_loop', $1, $2, 'Xato takrori', 'bir xil xato', '{"count":7}', 'e1') RETURNING id`, [s.id, a.machineId]);
    await putSettings(c.token, { opsFolders: { [a.machineId]: '/ops/wd' } }).expect(200);
    const res = await investigate(c.token, { kind: 'watchdog', id: al.id }).expect(201);
    expect(res.body.investigation).toMatchObject({ subjectKind: 'watchdog', machineId: a.machineId });
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    await svc(CommandsService).confirm(res.body.command.id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null });
    const d = await a.nextOf('command.dispatch');
    expect((d.payload.payload as { prompt: string }).prompt).toContain('watchdog');
    expect((d.payload.payload as { prompt: string }).prompt).toContain('count=7');
    expect(d.payload.payload).toMatchObject({ permissionMode: 'plan', cwd: '/ops/wd' });
  });

  it('read scope: tekshiruvni boshlay/sozlay olmaydi (403), ro\'yxat va sozlamalarni o\'qiy oladi', async () => {
    const ro = await issueToken(['read']);
    await investigate(ro.token, { kind: 'health', id: randomUUID() }).expect(403);
    await putSettings(ro.token, { model: 'opus' }).expect(403);
    await http().get('/v1/investigations').set(bearer(ro.token)).expect(200);
    await http().get('/v1/investigations/settings').set(bearer(ro.token)).expect(200);
  });
});
