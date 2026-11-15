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


// --- 3.7 e2e: HAQIQIY agentd ConfigSync (vaqtinchalik CLAUDE_CONFIG_DIR) <-> haqiqiy center + DB + WS ---------------------------

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigChunkPayload as Chunk } from '@commander/contracts';

/** Minimal tur: agentd manbasi center tsconfig'ining rootDir'idan tashqarida, shu sabab dinamik (turlanmagan) import. */
interface AgentSync {
  onChunk(c: unknown): void;
  capture(p: unknown): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }>;
  apply(p: unknown): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }>;
  rollback(p: unknown): Promise<{ ok: boolean; result?: unknown; code?: string; message?: string }>;
  report(): unknown;
}
type ConfigSync = AgentSync;
let ConfigSyncCtor: new (d: Record<string, unknown>) => AgentSync;
beforeAll(async () => {
  const path = new URL('../../../agentd/src/config-sync.ts', import.meta.url).href;
  ConfigSyncCtor = ((await import(/* @vite-ignore */ path)) as { ConfigSync: typeof ConfigSyncCtor }).ConfigSync;
});

const nolog = { info() {}, warn() {}, error() {}, debug() {}, child() { return nolog; } } as never;

/** Soxta "daemon": config buyruqlarini haqiqiy `ConfigSync`ga yo'naltiradi (imzo tekshiruvi agentd `command-verify` testlarida). */
function wireAgent(a: Agent, sync: ConfigSync): void {
  a.ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    if (m.type === 'config.chunk') sync.onChunk(m.payload as unknown as Chunk);
    if (m.type !== 'command.dispatch') return;
    const p = m.payload as { commandId: string; type: string; payload: never };
    if (!p.type.startsWith('config.')) return;
    void (async () => {
      a.send(createEnvelope('command.ack', { commandId: p.commandId }));
      const out = p.type === 'config.capture' ? await sync.capture(p.payload as never) : p.type === 'config.apply' ? await sync.apply(p.payload as never) : await sync.rollback(p.payload as never);
      a.send(createEnvelope('command.result', { commandId: p.commandId, state: out.ok ? 'done' : 'failed', ...(out.ok ? { result: out.result } : { error: { code: out.code ?? 'internal', message: out.message ?? 'failed' } }) }));
      a.send(createEnvelope('agent.heartbeat', { control: CONTROL_ON, config: sync.report() })); // qo'llash/qaytarishdan keyin darhol hisobot
    })();
  });
}

describe('3.7 e2e: haqiqiy ConfigSync (temp dir) <-> center', () => {
  const base = mkdtempSync(join(tmpdir(), 'cfg-e2e-'));
  const w = (dir: string, rel: string, c: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), c);
  };
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('capture -> diff -> apply (step-up) -> in_sync -> drift -> rollback', async () => {
    const srcDir = join(base, 'src');
    const dstDir = join(base, 'dst');
    w(srcDir, 'CLAUDE.md', '# Global\nbirinchi qoida\n');
    w(srcDir, 'agents/rev.md', 'reviewer agent');
    w(srcDir, 'skills/x/SKILL.md', '---\nname: x\n---\nskill');
    w(srcDir, 'settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node commander-hook.mjs' }] }] }, env: { FOO_MODE: 'fast', COMMANDER_URL: 'x' }, permissions: { allow: ['Bash(git status:*)'] } }));
    w(srcDir, 'history.jsonl', 'maxfiy');
    w(dstDir, 'CLAUDE.md', '# Global\neski qoida\n');
    w(dstDir, 'settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node commander-hook.mjs' }] }] }, permissions: { allow: ['Read'], defaultMode: 'plan' } }, null, 2));
    const dstSettingsBefore = readFileSync(join(dstDir, 'settings.json'), 'utf8');

    const srcA = await newAgent('zz-e2e-src');
    const dstA = await newAgent('zz-e2e-dst');
    const syncSrc = new ConfigSyncCtor({ claudeDir: srcDir, home: join(base, 'src-home'), log: nolog, sendChunk: (c: unknown) => (srcA.send(createEnvelope('config.chunk', c)), true) });
    const syncDst = new ConfigSyncCtor({ claudeDir: dstDir, home: join(base, 'dst-home'), log: nolog, sendChunk: () => true });
    wireAgent(srcA, syncSrc);
    wireAgent(dstA, syncDst);
    const ctl = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');

    const cap = await cfgPost(ctl.token, 'profiles/capture', { machineId: srcA.machineId, name: 'e2e' }).expect(201);
    expect(cap.body.profile).toMatchObject({ version: 1, fileCount: 3, hasSettings: true });
    expect(cap.body.skipped.map((s: { path: string }) => s.path)).toEqual(expect.arrayContaining(['settings.json']));
    const detail = await http().get(`/v1/config/profiles/${cap.body.profile.id}`).set(bearer(ctl.token)).expect(200);
    expect(detail.body.settings).toEqual({ permissions: { allow: ['Bash(git status:*)'], deny: [] }, env: { FOO_MODE: 'fast' } });
    expect(JSON.stringify(detail.body)).not.toContain('commander-hook');

    const diff = await cfgPost(ctl.token, `machines/${dstA.machineId}/diff`, { profileId: cap.body.profile.id, mode: 'merge' }).expect(200);
    const upd = diff.body.plan.entries.find((e: { path: string }) => e.path === 'CLAUDE.md');
    expect(upd).toMatchObject({ action: 'update' });
    expect(upd.diff).toContain('-eski qoida');
    expect(upd.diff).toContain('+birinchi qoida');
    expect(diff.body.plan.summary).toMatchObject({ add: 2, update: 1 });
    expect(readFileSync(join(dstDir, 'CLAUDE.md'), 'utf8')).toContain('eski'); // dry-run yozmaydi

    const ap = await cfgPost(ctl.token, `machines/${dstA.machineId}/apply`, { profileId: cap.body.profile.id, mode: 'merge', expectedPlanHash: diff.body.plan.planHash }).expect(201);
    expect(ap.body.command.status).toBe('awaiting_confirmation');
    expect((await svc(CommandsService).confirm(ap.body.command.id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null })).outcome).toBe('confirmed');
    await eventually(() => statusOf(ap.body.command.id), (r) => r.status === 'done', 8000);
    expect(readFileSync(join(dstDir, 'CLAUDE.md'), 'utf8')).toBe('# Global\nbirinchi qoida\n');
    expect(existsSync(join(dstDir, 'skills/x/SKILL.md'))).toBe(true);
    const s = JSON.parse(readFileSync(join(dstDir, 'settings.json'), 'utf8'));
    expect(s.hooks.Stop[0].hooks[0].command).toBe('node commander-hook.mjs'); // Commander hook'iga tegilmadi
    expect(s.permissions).toEqual({ allow: ['Read', 'Bash(git status:*)'], defaultMode: 'plan' });
    expect(s.env).toEqual({ FOO_MODE: 'fast' });

    const st = await eventually(async () => (await http().get('/v1/config/status').query({ profile: 'e2e' }).set(bearer(ctl.token)).expect(200)).body, (b) => b.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId)?.status === 'in_sync', 6000);
    const row = st.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId);
    expect(row.backups).toHaveLength(1);

    // Lokal o'zgarish -> drift
    w(dstDir, 'agents/rev.md', 'lokal tahrir');
    dstA.send(createEnvelope('agent.heartbeat', { control: CONTROL_ON, config: syncDst.report() }));
    const drift = await eventually(async () => (await http().get('/v1/config/status').query({ profile: 'e2e' }).set(bearer(ctl.token)).expect(200)).body, (b) => b.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId)?.status === 'drift', 6000);
    expect(drift.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId).drift.modified).toEqual(['agents/rev.md']);
    w(dstDir, 'agents/rev.md', 'reviewer agent'); // lokal tahrirni qaytarib, rollback sinovi

    // Rollback
    const rb = await cfgPost(ctl.token, `machines/${dstA.machineId}/rollback`, { backupId: row.backups[0].id }).expect(201);
    expect((await svc(CommandsService).confirm(rb.body.command.id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null })).outcome).toBe('confirmed');
    await eventually(() => statusOf(rb.body.command.id), (r) => r.status === 'done', 8000);
    expect(readFileSync(join(dstDir, 'CLAUDE.md'), 'utf8')).toBe('# Global\neski qoida\n');
    expect(existsSync(join(dstDir, 'skills/x/SKILL.md'))).toBe(false);
    expect(existsSync(join(dstDir, 'agents/rev.md'))).toBe(false);
    expect(readFileSync(join(dstDir, 'settings.json'), 'utf8')).toBe(dstSettingsBefore);
    const after = await eventually(async () => (await http().get('/v1/config/status').set(bearer(ctl.token)).expect(200)).body, (b) => b.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId)?.status === 'not_applied', 6000);
    expect(after.machines.find((m: { machineId: string }) => m.machineId === dstA.machineId).status).toBe('not_applied');
  });
});
