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
  buildAgentAuthString,
  buildClientSubprotocols,
  createEnvelope,
} from '@commander/contracts';
import type { CommandDto } from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { ConfigSyncModule } from '../../src/config-sync/config-sync.module.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import { StepUpRegistry } from '../../src/commands/step-up.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
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

/**
 * 2.3-2.7 e2e (center tomoni): haqiqiy TimescaleDB + haqiqiy `ws` (agent, klient) + haqiqiy Ed25519 (agent auth VA markaz buyruq imzosi).
 * Telegram o'rniga soxta step-up kanali (`StepUpRegistry`); tasdiq `CommandsService.confirm` orqali (Telegram callback shuni chaqiradi).
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
interface Agent extends Sock { deviceId: string; machineId: string; keys: { priv: KeyObject; pubB64: string }; authOk: Msg }

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
const sockets: WebSocket[] = [];
let stepUpAvailable = true;
const stepUpRequests: CommandDto[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, ConfigSyncModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 30_000, revokeCheckIntervalMs: 100 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    // Muddat tekshiruvi qo'lda (`sweep(now)`), limitlar yuqori (boshqa testlarga halaqit bermasin); keyFile xotirada.
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'config.capture': [1000, 60_000], 'config.apply': [1000, 60_000], 'config.rollback': [1000, 60_000] } })
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
      stepUpRequests.push(c);
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
    ws, all,
    send: (m) => ws.send(JSON.stringify(m)),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    nextOf: (type, ms = 3000) => waitFor((m) => m.type === type, ms, type),
    nextWhere: (match, ms = 3000, label = 'matching message') => waitFor(match, ms, label),
    expectNone: async (type, ms = 400) => {
      const start = all.length;
      await sleep(ms);
      expect(all.slice(start).filter((m) => m.type === type)).toHaveLength(0);
    },
  };
}

async function enrollAgent(name: string): Promise<{ deviceId: string; machineId: string; keys: Agent['keys']; centerKey: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: keys.pubB64, hardware_id: `hw-cmd-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys, centerKey: res.body.center_public_key as string };
}

const CONTROL_ON = {
  configSync: true, allowConfigRead: true, allowConfigWrite: true, enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };

async function newAgent(name: string, control: Record<string, unknown> | null = CONTROL_ON): Promise<Agent & { centerKey: string }> {
  const e = await enrollAgent(name);
  const c = openSocket(AGENT_WS_PATH);
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId: e.deviceId, ts, signature, agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', hostname: `${name}-host`, os: 'linux' }));
  const authOk = await c.nextOf('auth.ok');
  const agent = { ...c, deviceId: e.deviceId, machineId: e.machineId, keys: e.keys, authOk, centerKey: e.centerKey };
  if (control) {
    c.send(createEnvelope('agent.heartbeat', { control }));
    await eventually(async () => (await ds.query(`SELECT control FROM machines WHERE id = $1`, [e.machineId]))[0].control, (v) => v !== null);
  }
  return agent;
}

async function issueToken(scopes: string[], kind: 'web' | 'telegram' | 'mobile' = 'web'): Promise<{ id: string; token: string }> {
  const t = await svc(ClientTokensService).issue({ kind, name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
}

async function connectClient(token: string): Promise<Sock> {
  const c = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(token));
  await c.opened;
  await c.nextOf('auth.ok');
  c.send(createEnvelope('subscribe', { channels: ['commands'] }));
  await c.nextOf('subscribed');
  return c;
}


// --- 3.7 testlari ----------------------------------------------------------------------------------------

import { encodeBundle } from '../../src/config-sync/config-bundle.js';
import { sha256Hex, fragmentSha256 } from '../../src/config-sync/config-validate.js';
import type { ConfigChunkPayload, ConfigResult, SettingsFragment } from '@commander/contracts';

const file = (path: string, content: string, kind: 'claude_md' | 'agent' | 'skill' | 'command' = 'agent') => ({ path, kind, content, sha256: sha256Hex(content), size: Buffer.byteLength(content), exec: false });

/** Agent: capture buyrug'iga javob (bo'laklar OLDIN, natija KEYIN). */
async function answerCapture(a: Agent, files: ReturnType<typeof file>[], settings: SettingsFragment | null, opts: { skipped?: Array<{ path: string; reason: string }>; tamper?: boolean } = {}): Promise<string> {
  const d = await a.nextWhere((m) => m.type === 'command.dispatch' && m.payload.type === 'config.capture', 5000, 'config.capture dispatch');
  const commandId = d.payload.commandId as string;
  const enc = files.length > 0 || settings ? encodeBundle({ files: files.map((f) => ({ path: f.path, content: opts.tamper ? f.content + 'X' : f.content })), settings }) : null;
  for (const c of enc?.chunks ?? []) a.send(createEnvelope('config.chunk', c));
  a.send(createEnvelope('command.ack', { commandId }));
  const result: ConfigResult = {
    kind: 'capture',
    items: files.map(({ content: _c, ...i }) => i),
    skipped: opts.skipped ?? [],
    settingsSha256: settings ? fragmentSha256(settings) : null,
    bundle: enc?.ref ?? null,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
  a.send(createEnvelope('command.result', { commandId, state: 'done', result: { detail: 'captured', config: result } }));
  return commandId;
}

const statusOf = async (id: string): Promise<{ status: string; error_code: string | null }> => (await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [id]))[0];

const cfgPost = (token: string, path: string, body: unknown, key?: string) => {
  const r = http().post(`/v1/config/${path}`).set(bearer(token));
  return (key ? r.set('Idempotency-Key', key) : r).send(body as object);
};

describe('3.7 sozlamalar sinxronlash (markaz)', () => {
  let src: Agent & { centerKey: string };
  let dst: Agent & { centerKey: string };
  let ctl: { id: string; token: string };
  let reader: { id: string; token: string };
  let confirmer: { id: string; token: string };
  const settings: SettingsFragment = { permissions: { allow: ['Bash(git status:*)'], deny: [] }, env: { FOO_MODE: 'fast' } };
  let profileId = '';
  let planHash = '';

  beforeAll(async () => {
    src = await newAgent('zz-cfg-src');
    dst = await newAgent('zz-cfg-dst');
    ctl = await issueToken(['read', 'control']);
    reader = await issueToken(['read']);
    confirmer = await issueToken(['read', 'approve'], 'telegram');
  });

  it('capture: scope, bo\'laklar + natija -> versiya 1; sirli fayl markazda ham tashlanadi; DB\'da mazmun faqat profil jadvalida', async () => {
    await cfgPost(reader.token, 'profiles/capture', { machineId: src.machineId }).expect(403);
    const files = [file('CLAUDE.md', '# salom\n', 'claude_md'), file('agents/a.md', 'agent A'), file('skills/s/SKILL.md', 'skill', 'skill'), file('agents/leak.md', 'token = sk-ant-abcdefghijklmnop1234')];
    const req = cfgPost(ctl.token, 'profiles/capture', { machineId: src.machineId, name: 'default' }).then((r) => r);
    const commandId = await answerCapture(src, files, settings, { skipped: [{ path: 'history.jsonl', reason: 'path is outside the managed set' }] });
    const res = await req;
    expect(res.status).toBe(201);
    expect(res.body.profile).toMatchObject({ name: 'default', version: 1, fileCount: 3, hasSettings: true, latest: true, sourceMachineId: src.machineId });
    expect(res.body.skipped.map((s: { path: string }) => s.path).sort()).toEqual(['agents/leak.md', 'history.jsonl']);
    expect(res.body.commandId).toBe(commandId);
    profileId = res.body.profile.id as string;
    // commands.result'da mazmun/diff YO'Q, faqat qisqa izoh
    const [row] = await ds.query(`SELECT result::text AS r, payload::text AS p FROM commands WHERE id = $1`, [commandId]);
    expect(row.r).not.toContain('salom');
    expect(row.r).toContain('captured');
    const audit = await ds.query(`SELECT action FROM audit_log WHERE target = $1`, [commandId]);
    expect(audit.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['command.created', 'command.dispatched', 'command.result']));
    expect((await ds.query(`SELECT count(*)::int AS n FROM config_profile_files WHERE profile_id = $1`, [profileId]))[0].n).toBe(3);
  });

  it('capture: bundle xeshi mos kelmasa 502 va hech narsa saqlanmaydi; ikkinchi muvaffaqiyatli capture = versiya 2', async () => {
    const before = (await ds.query(`SELECT count(*)::int AS n FROM config_profiles`))[0].n;
    const bad = cfgPost(ctl.token, 'profiles/capture', { machineId: src.machineId, name: 'default' }).then((r) => r);
    await answerCapture(src, [file('agents/a.md', 'A')], null, { tamper: true });
    expect((await bad).status).toBe(502);
    expect((await ds.query(`SELECT count(*)::int AS n FROM config_profiles`))[0].n).toBe(before);

    const ok = cfgPost(ctl.token, 'profiles/capture', { machineId: src.machineId, name: 'default' }).then((r) => r);
    await answerCapture(src, [file('CLAUDE.md', '# v2\n', 'claude_md'), file('agents/a.md', 'agent A v2')], settings);
    const res = await ok;
    expect(res.body.profile).toMatchObject({ version: 2, latest: true });
    profileId = res.body.profile.id as string;
    const list = await http().get('/v1/config/profiles').set(bearer(reader.token)).expect(200);
    expect(list.body.items.filter((p: { name: string }) => p.name === 'default').map((p: { version: number; latest: boolean }) => [p.version, p.latest])).toEqual([[2, true], [1, false]]);
  });

  it('profil tafsiloti va fayl ko\'ruvchi', async () => {
    const d = await http().get(`/v1/config/profiles/${profileId}`).set(bearer(reader.token)).expect(200);
    expect(d.body.files.map((f: { path: string }) => f.path)).toEqual(['CLAUDE.md', 'agents/a.md']);
    expect(d.body.settings.env).toEqual({ FOO_MODE: 'fast' });
    const f = await http().get(`/v1/config/profiles/${profileId}/file`).query({ path: 'agents/a.md' }).set(bearer(reader.token)).expect(200);
    expect(f.body.content).toBe('agent A v2');
    await http().get(`/v1/config/profiles/${profileId}/file`).query({ path: '../etc/passwd' }).set(bearer(reader.token)).expect(404);
  });

  it('diff (dry-run): bo\'laklar dispatchdan OLDIN, imzolangan buyruq, reja qaytadi; step-up YO\'Q', async () => {
    const req = cfgPost(ctl.token, `machines/${dst.machineId}/diff`, { profileId, mode: 'merge' }).then((r) => r);
    const d = await dst.nextWhere((m) => m.type === 'command.dispatch' && m.payload.type === 'config.apply', 5000, 'apply dispatch');
    const idxDispatch = dst.all.indexOf(d);
    const chunks = dst.all.slice(0, idxDispatch).filter((m) => m.type === 'config.chunk').map((m) => m.payload as unknown as ConfigChunkPayload);
    const payload = d.payload.payload as { dryRun: boolean; bundle: { chunks: number; sha256: string }; items: Array<{ path: string }>; mode: string };
    expect(payload).toMatchObject({ dryRun: true, mode: 'merge' });
    expect(payload.items.map((i) => i.path)).toEqual(['CLAUDE.md', 'agents/a.md']);
    expect(chunks.filter((c) => c.transferId === payload.bundle.sha256)).toHaveLength(payload.bundle.chunks);
    expect(typeof d.payload.sig).toBe('string');
    const commandId = d.payload.commandId as string;
    dst.send(createEnvelope('command.ack', { commandId }));
    const plan: ConfigResult = {
      kind: 'plan',
      planHash: 'a'.repeat(64),
      mode: 'merge',
      entries: [{ path: 'CLAUDE.md', kind: 'claude_md', action: 'add', diff: '--- /dev/null\n+++ profile/CLAUDE.md\n@@ -0,0 +1,1 @@\n+# v2\n' }, { path: 'agents/a.md', kind: 'agent', action: 'add' }],
      settings: { changed: true, allowAdd: ['Bash(git status:*)'], allowRemove: [], denyAdd: [], denyRemove: [], envSet: ['FOO_MODE=fast'], envRemove: [], refused: [] },
      summary: { add: 2, update: 0, delete: 0, unchanged: 0, skip: 0 },
      truncated: false,
    };
    dst.send(createEnvelope('command.result', { commandId, state: 'done', result: { detail: 'plan', config: plan } }));
    const res = await req;
    expect(res.status).toBe(200);
    expect(res.body.plan.summary.add).toBe(2);
    planHash = res.body.plan.planHash as string;
    // diff matni DB'ga tushmagan
    const [row] = await ds.query(`SELECT result::text AS r, status, step_up_required FROM commands WHERE id = $1`, [commandId]);
    expect(row.r).not.toContain('profile/CLAUDE.md');
    expect(row.step_up_required).toBe(false);
  });

  it('apply: expectedPlanHash shart (400); haqiqiy qo\'llash step-up kutadi, tasdiqdan keyin bo\'laklar + imzolangan dispatch; mazmun DB\'da YO\'Q', async () => {
    await cfgPost(ctl.token, `machines/${dst.machineId}/apply`, { profileId, mode: 'merge' }).expect(400);
    stepUpAvailable = true;
    const res = await cfgPost(ctl.token, `machines/${dst.machineId}/apply`, { profileId, mode: 'merge', expectedPlanHash: planHash }, `cfg-apply-${randomUUID()}`).expect(201);
    expect(res.body.command).toMatchObject({ type: 'config.apply', status: 'awaiting_confirmation', stepUp: { required: true } });
    const id = res.body.command.id as string;
    expect(res.body.command.promptPreview).toContain('default');
    const mark = dst.all.length;
    await dst.expectNone('command.dispatch', 300);
    expect(dst.all.length).toBe(mark);
    expect((await svc(CommandsService).confirm(id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null })).outcome).toBe('confirmed');
    const d = await dst.nextWhere((m) => m.type === 'command.dispatch' && m.payload.commandId === id, 5000, 'apply dispatch');
    expect(d.payload.payload).toMatchObject({ dryRun: false, expectedPlanHash: planHash });
    const [row] = await ds.query(`SELECT payload::text AS p FROM commands WHERE id = $1`, [id]);
    expect(row.p).not.toContain('agent A v2');
    expect(row.p).toContain('planHash');
    dst.send(createEnvelope('command.ack', { commandId: id }));
    dst.send(createEnvelope('command.result', { commandId: id, state: 'done', result: { detail: '2 add, 0 update, 0 delete; backup config-1731403200001', config: { kind: 'apply', backupId: 'config-1731403200001', applied: { add: 2, update: 0, delete: 0 }, settingsChanged: true } } }));
    await eventually(() => statusOf(id), (r) => r.status === 'done');
  });

  it('heartbeat hisoboti: sinxron -> in_sync; fayl o\'zgarsa drift', async () => {
    const files = await ds.query(`SELECT path, sha256 FROM config_profile_files WHERE profile_id = $1 ORDER BY path`, [profileId]);
    const [{ settings_sha256 }] = await ds.query(`SELECT settings_sha256 FROM config_profiles WHERE id = $1`, [profileId]);
    const report = (mod: Record<string, string | null> = {}, intact = true) => ({
      files: files.map((f: { path: string; sha256: string }) => ({ path: f.path, sha256: f.path in mod ? mod[f.path] : f.sha256 })),
      applied: { profileName: 'default', profileVersion: 2, mode: 'merge', appliedAt: Date.now() },
      settings: { sha256: settings_sha256, intact },
      backups: [{ id: 'config-1731403200001', createdAt: Date.now(), profileName: 'default', profileVersion: 2 }],
      at: Date.now(),
    });
    dst.send(createEnvelope('agent.heartbeat', { control: CONTROL_ON, config: report() }));
    const s1 = await eventually(async () => (await http().get('/v1/config/status').set(bearer(reader.token)).expect(200)).body, (b) => b.machines.find((m: { machineId: string }) => m.machineId === dst.machineId)?.status === 'in_sync');
    const row = s1.machines.find((m: { machineId: string }) => m.machineId === dst.machineId);
    expect(row).toMatchObject({ status: 'in_sync', supported: true, allowWrite: true, applied: { profileName: 'default', profileVersion: 2 }, latestVersion: 2 });
    expect(row.backups[0].id).toBe('config-1731403200001');
    expect(s1.profile).toMatchObject({ name: 'default', version: 2 });
    // manba mashina hisobotsiz: unknown; heartbeat'siz agent
    expect(s1.machines.find((m: { machineId: string }) => m.machineId === src.machineId)?.status).toBe('unknown');

    dst.send(createEnvelope('agent.heartbeat', { control: CONTROL_ON, config: report({ 'agents/a.md': 'b'.repeat(64) }) }));
    const s2 = await eventually(async () => (await http().get('/v1/config/status').set(bearer(reader.token)).expect(200)).body, (b) => b.machines.find((m: { machineId: string }) => m.machineId === dst.machineId)?.status === 'drift');
    expect(s2.machines.find((m: { machineId: string }) => m.machineId === dst.machineId).drift).toMatchObject({ modified: ['agents/a.md'], outdated: false });
  });

  it('rollback: noma\'lum zaxira 409; ma\'lum zaxira step-up bilan', async () => {
    await cfgPost(ctl.token, `machines/${dst.machineId}/rollback`, { backupId: 'config-1731403299999' }).expect(409);
    await cfgPost(ctl.token, `machines/${dst.machineId}/rollback`, { backupId: '../../etc' }).expect(400);
    const res = await cfgPost(ctl.token, `machines/${dst.machineId}/rollback`, { backupId: 'config-1731403200001' }).expect(201);
    expect(res.body.command).toMatchObject({ type: 'config.rollback', status: 'awaiting_confirmation' });
    await http().post(`/v1/commands/${res.body.command.id}/cancel`).set(bearer(ctl.token)).expect(200);
  });

  it('siyosat: yozish o\'chiq bo\'lsa apply rejected(config_not_allowed), dry-run o\'qish bilan o\'tadi; eski agentd agent_outdated', async () => {
    const ro = await newAgent('zz-cfg-ro', { ...CONTROL_ON, allowConfigWrite: false });
    const res = await cfgPost(ctl.token, `machines/${ro.machineId}/apply`, { profileId, mode: 'merge', expectedPlanHash: planHash }).expect(201);
    expect(res.body.command).toMatchObject({ status: 'rejected', errorCode: 'config_not_allowed' });
    await ro.expectNone('command.dispatch', 300);
    const old = await newAgent('zz-cfg-old', { ...CONTROL_ON, configSync: undefined });
    const r2 = await cfgPost(ctl.token, `machines/${old.machineId}/apply`, { profileId, mode: 'merge', expectedPlanHash: planHash }).expect(201);
    expect(r2.body.command).toMatchObject({ status: 'rejected', errorCode: 'agent_outdated' });
    const st = await http().get('/v1/config/status').set(bearer(reader.token)).expect(200);
    expect(st.body.machines.find((m: { machineId: string }) => m.machineId === old.machineId).supported).toBe(false);
  });

  it('settings: drift ogohlantirishi default o\'chiq; PUT control scope', async () => {
    expect((await http().get('/v1/config/settings').set(bearer(reader.token)).expect(200)).body).toEqual({ driftNotify: false });
    await http().put('/v1/config/settings').set(bearer(reader.token)).send({ driftNotify: true }).expect(403);
    await http().put('/v1/config/settings').set(bearer(ctl.token)).send({ driftNotify: true }).expect(200);
    expect((await http().get('/v1/config/settings').set(bearer(reader.token)).expect(200)).body).toEqual({ driftNotify: true });
  });

  it('yaroqsiz config.chunk nack oladi (ulanish yiqilmaydi)', async () => {
    const env = createEnvelope('config.chunk', { transferId: 'zz', seq: 0, total: 1, data: 'QQ==' });
    dst.send(env);
    const n = await dst.nextWhere((m) => m.type === 'nack' && m.payload.id === env.id);
    expect(n.payload.code).toBe('invalid_payload');
  });
});
