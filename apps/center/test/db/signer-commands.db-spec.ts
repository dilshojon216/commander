import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { AGENT_WS_PATH, CreateCommandResponseSchema, buildAgentAuthString, buildCommandSigString, createEnvelope } from '@commander/contracts';
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
import { CommandSignerService } from '../../src/commands/command-signer.service.js';
import { hashCommandPayload } from '../../src/commands/command-signer.js';
import { StepUpRegistry } from '../../src/commands/step-up.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { CenterKeyAdminService } from '../../src/identity/center-key-admin.service.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { FakeSigner } from '../support/fake-signer.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 5.7 (H-02): markaz kalitni ko'rmaydi, imzoni host imzolovchidan so'raydi. Soxta imzolovchi (TCP, HMAC handshake) + haqiqiy DB/ws.
 * Imzolovchi yo'q/qulflangan bo'lsa buyruq YUBORILMAYDI (fail-closed) va aniq xato kodi bilan failed bo'ladi.
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
const fake = new FakeSigner();
const sockets: WebSocket[] = [];

beforeAll(async () => {
  await fake.start();
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 30_000, revokeCheckIntervalMs: 600_000 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 600_000, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({
      ...DEFAULT_COMMANDS_OPTIONS,
      sweepMs: 3_600_000,
      keyFile: null,
      signer: { endpoint: `tcp://127.0.0.1:${fake.port}`, authFile: fake.authFile },
      signerRequired: true,
    })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  port = (app.getHttpServer().address() as AddressInfo).port;
  app.get(StepUpRegistry).register({ isAvailable: async () => true, request: async (_c: CommandDto) => 1 });
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await db.drop();
  await fake.close();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

interface Agent { ws: WebSocket; all: Msg[]; deviceId: string; machineId: string; keys: { priv: KeyObject; pubB64: string }; authOk: Msg; centerKey: string }

function inbox(ws: WebSocket): { all: Msg[]; wait: (match: (m: Msg) => boolean, ms?: number) => Promise<Msg>; none: (type: string, ms?: number) => Promise<void> } {
  const all: Msg[] = [];
  const waiters: Array<{ match: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  const queue: Msg[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    all.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else queue.push(m);
  });
  return {
    all,
    wait: (match, ms = 3000) =>
      new Promise((resolve, reject) => {
        const i = queue.findIndex(match);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]!);
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    none: async (type, ms = 400) => {
      const start = all.length;
      await sleep(ms);
      expect(all.slice(start).filter((m) => m.type === type)).toHaveLength(0);
    },
  };
}

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };

async function enroll(name: string): Promise<{ deviceId: string; machineId: string; keys: Agent['keys']; centerKey: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: keys.pubB64, hardware_id: `hw-sg-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys, centerKey: res.body.center_public_key as string };
}

async function connect(e: Awaited<ReturnType<typeof enroll>>, fingerprint?: string): Promise<Agent & { wait: ReturnType<typeof inbox>['wait']; none: ReturnType<typeof inbox>['none'] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${AGENT_WS_PATH}`);
  sockets.push(ws);
  const box = inbox(ws);
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  const ch = await box.wait((m) => m.type === 'auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url');
  ws.send(JSON.stringify(createEnvelope('auth.response', { deviceId: e.deviceId, ts, signature, agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', hostname: 'h', os: 'linux', ...(fingerprint ? { centerKeyFingerprint: fingerprint } : {}) })));
  const authOk = await box.wait((m) => m.type === 'auth.ok');
  ws.send(JSON.stringify(createEnvelope('agent.heartbeat', { control: CONTROL_ON })));
  for (let i = 0; i < 80; i++) {
    if ((await ds.query(`SELECT control FROM machines WHERE id = $1`, [e.machineId]))[0].control) break;
    await sleep(25);
  }
  return { ws, all: box.all, wait: box.wait, none: box.none, deviceId: e.deviceId, machineId: e.machineId, keys: e.keys, authOk, centerKey: e.centerKey };
}

const issueToken = async (scopes: string[], kind: 'web' | 'telegram' | 'mobile' = 'web'): Promise<{ id: string; token: string }> => {
  const t = await svc(ClientTokensService).issue({ kind, name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
};
const actorOf = (deviceId: string): CommandActor => ({ deviceId, actorKind: 'telegram', ip: null });
const startBody = (machineId: string) => ({ type: 'session.start', machineId, cwd: '/zz/proj', prompt: 'tiny task', permissionMode: 'plan', model: 'haiku' });
const statusOf = async (id: string): Promise<{ status: string; error_code: string | null }> => (await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [id]))[0];

async function startAndConfirm(agent: { machineId: string }): Promise<string> {
  const requester = await issueToken(['read', 'control']);
  const confirmer = await issueToken(['read', 'approve'], 'telegram');
  const res = await http().post('/v1/commands').set(bearer(requester.token)).send(startBody(agent.machineId)).expect(201);
  const cmd = CreateCommandResponseSchema.parse(res.body).command;
  expect((await svc(CommandsService).confirm(cmd.id, actorOf(confirmer.id))).outcome).toBe('confirmed');
  return cmd.id;
}

function verifyDispatch(centerKey: string, deviceId: string, m: Msg): boolean {
  const p = m.payload as { commandId: string; type: 'session.start'; nonce: string; expiresAt: number; sig: string; payload: unknown };
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: centerKey }, format: 'jwk' });
  const s = buildCommandSigString({ deviceId, commandId: p.commandId, type: p.type, nonce: p.nonce, expiresAt: p.expiresAt, payloadSha256: hashCommandPayload(p.payload) });
  return verify(null, Buffer.from(s, 'utf8'), pub, Buffer.from(p.sig, 'base64url'));
}

describe('markaz imzoni host imzolovchidan oladi (5.7)', () => {
  it('enrollment va auth.ok imzolovchining public key\'ini beradi; dispatch imzosi shu kalit bilan tekshiriladi; imzolovchi logiga yozilgan', async () => {
    const e = await enroll('zz-sg-flow');
    expect(e.centerKey).toBe(fake.publicKey);
    const a = await connect(e);
    expect(a.authOk.payload.centerPublicKey).toBe(fake.publicKey);
    const before = fake.signed.length;
    const id = await startAndConfirm(a);
    const d = await a.wait((m) => m.type === 'command.dispatch');
    expect(d.payload.commandId).toBe(id);
    expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
    expect(fake.signed.length).toBe(before + 1);
    expect(fake.signed.at(-1)).toMatchObject({ op: 'sign_command', deviceId: a.deviceId, commandId: id, type: 'session.start' });
    expect((await statusOf(id)).status).toBe('sent');
  });

  it('imzolovchi o\'chgan: buyruq YUBORILMAYDI, failed(signer_unavailable), audit yoziladi; tiklangach yana ishlaydi', async () => {
    const a = await connect(await enroll('zz-sg-down'));
    await fake.stop();
    const id = await startAndConfirm(a);
    await a.none('command.dispatch', 600);
    const row = await statusOf(id);
    expect(row).toMatchObject({ status: 'failed', error_code: 'signer_unavailable' });
    const audit = await ds.query(`SELECT action FROM audit_log WHERE target = $1`, [id]);
    expect(audit.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['command.dispatched', 'command.failed']));
    // fallback yo'q: ulanish tiklangach (signer qayta ishga tushdi) imzo yana ishlaydi
    await fake.start(fake.port);
    const id2 = await startAndConfirm(a);
    const d = await a.wait((m) => m.type === 'command.dispatch');
    expect(d.payload.commandId).toBe(id2);
    expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
  });

  it('LOCK (qo\'lda kill-switch): failed(signer_locked), dispatch yo\'q', async () => {
    const a = await connect(await enroll('zz-sg-lock'));
    fake.locked = true;
    try {
      const id = await startAndConfirm(a);
      await a.none('command.dispatch', 500);
      expect(await statusOf(id)).toMatchObject({ status: 'failed', error_code: 'signer_locked' });
    } finally {
      fake.locked = false;
    }
  });

  it('center-key rotate imzolovchi orqali: yangi kalit imzolovchi ichida; eski pin\'li agent e\'lonni oladi; yangi kalit bilan imzolanadi', async () => {
    const signer = svc(CommandSignerService);
    const before = { pub: signer.publicKey, fp: signer.fingerprint };
    const e = await enroll('zz-sg-rotate');
    const r = await svc(CenterKeyAdminService).rotate(7, 'test');
    expect(r.previousFingerprint).toBe(before.fp);
    expect(signer.fingerprint).toBe(r.newFingerprint);
    expect(signer.publicKey).toBe(fake.publicKey);
    const old = await connect(e, before.fp);
    expect(old.authOk.payload.centerPublicKey).toBe(fake.publicKey);
    const rot = (old.authOk.payload.centerKeyRotations as Array<{ previousPublicKey: string; newPublicKey: string }>)[0]!;
    expect(rot).toMatchObject({ previousPublicKey: before.pub, newPublicKey: fake.publicKey });
    const id = await startAndConfirm(old);
    const d = await old.wait((m) => m.type === 'command.dispatch');
    expect(d.payload.commandId).toBe(id);
    expect(verifyDispatch(fake.publicKey, old.deviceId, d)).toBe(true);
    const audit = await ds.query(`SELECT details FROM audit_log WHERE action = 'center_key.rotated'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE|seed/);
  });
});
