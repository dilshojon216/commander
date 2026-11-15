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
import type { CommandType } from '@commander/contracts';
import { AGENT_WS_PATH, DeployInspectResultSchema, LogsReadResponseSchema, buildAgentAuthString, buildCommandSigString, createEnvelope } from '@commander/contracts';
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
import { LimitsModule } from '../../src/limits/limits.module.js';
import { DeployModule } from '../../src/deploy/deploy.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import type { CommandActor } from '../../src/commands/commands.service.js';
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
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, ProjectsModule, DeployModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 30_000, revokeCheckIntervalMs: 100 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'session.start': [1000, 60_000], 'deploy.inspect': [1000, 60_000], 'deploy.run': [1000, 60_000], 'deploy.rollback': [1000, 60_000], 'git.checkpoint': [1000, 60_000], 'git.checkpoint_list': [1000, 60_000], 'git.checkpoint_restore': [1000, 60_000] } })
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

const CONTROL = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, projectOps: true, allowProjectRead: true, allowProjectWrite: true, deploy: true, allowDeploy: true, allowDeployShell: false, checkpoints: true };

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
  const p = m.payload as { commandId: string; type: string; nonce: string; expiresAt: number; sig: string; payload: unknown };
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: centerKey }, format: 'jwk' });
  return verify(null, Buffer.from(buildCommandSigString({ deviceId, commandId: p.commandId, type: p.type as CommandType, nonce: p.nonce, expiresAt: p.expiresAt, payloadSha256: hashCommandPayload(p.payload) }), 'utf8'), pub, Buffer.from(p.sig, 'base64url'));
}

const statusOf = async (id: string): Promise<{ status: string; error_code: string | null }> => (await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [id]))[0];
const SECRET = 'ghp_' + 'Z'.repeat(30);


const SHA = 'a'.repeat(40);
const HASH = 'c'.repeat(64);
const actorOf = (deviceId: string, extra: Partial<CommandActor> = {}): CommandActor => ({ deviceId, actorKind: 'telegram', ip: null, ...extra });

interface Proj { id: string; slug: string; path: string }
async function newProject(a: Agent, path: string): Promise<Proj> {
  const [m] = await ds.query(`SELECT slug FROM machines WHERE id = $1`, [a.machineId]);
  const [p] = await ds.query(`INSERT INTO projects (machine_id, path, name, kind) VALUES ($1, $2, 'p', 'git') RETURNING id`, [a.machineId, path]);
  return { id: p.id as string, slug: m.slug as string, path };
}

const step = (name: string, argv: string[]) => ({ name, kind: 'argv', argv, shell: null, cwd: null, env: {}, timeoutSec: 60 });
function inspectResult(slug: string, over: Record<string, unknown> = {}, targetOver: Record<string, unknown> = {}) {
  return {
    commit: SHA, branch: 'main', dirty: false, recipePresent: true, workingTreeDiffers: false, valid: true, issues: [],
    recipe: { version: 1, targets: [{ name: 'prod', machine: slug, cwd: '.', timeoutSec: 600, preflight: [step('tests', ['npm', 'test'])], steps: [step('build', ['npm', 'run', 'build'])], health: { kind: 'http', url: 'http://127.0.0.1:3000/health', argv: [], expectStatus: [200], timeoutSec: 5, retries: 3, intervalSec: 2 }, rollback: [step('undo', ['./undo.sh'])], usesShell: false, ...targetOver }] },
    recipeHash: HASH, usesShell: false, machineMatches: { prod: true }, allowDeploy: true, allowDeployShell: false, ...over,
  };
}
const SUMMARY = (over: Record<string, unknown> = {}) => ({
  kind: 'run', target: 'prod', commit: SHA, recipeHash: HASH, outcome: 'success', failedPhase: null, failedStep: null,
  steps: [{ phase: 'preflight', name: 'tests', status: 'ok', exitCode: 0, durationMs: 5 }, { phase: 'steps', name: 'build', status: 'ok', exitCode: 0, durationMs: 9 }],
  health: { ok: true, attempts: 1, lastStatus: 200 }, rollbackDefined: true, durationMs: 30, outputTruncated: false, ...over,
});

/** Fake agent `deploy.inspect` ga javob beradi (ack + result). Dispatch imzosi ham tekshiriladi. */
async function answerInspect(a: Agent, result: unknown): Promise<Msg> {
  const d = await a.nextOf('command.dispatch');
  expect(d.payload.type).toBe('deploy.inspect');
  expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
  const id = d.payload.commandId as string;
  a.send(createEnvelope('command.ack', { commandId: id }));
  a.send(createEnvelope('command.result', { commandId: id, state: 'done', result: { deploy: result, detail: 'x' } }));
  return d;
}
const postInspect = (token: string, p: Proj, body: object = {}) => http().post(`/v1/projects/${p.id}/deploy/inspect`).set(bearer(token)).send(body);
const postRun = (token: string, p: Proj, body: object, kind: 'run' | 'rollback' = 'run') => http().post(`/v1/projects/${p.id}/deploy/${kind}`).set(bearer(token)).send(body);
const RUN = { target: 'prod', recipeHash: HASH, commit: SHA };

describe('migratsiya 6.5/6.9', () => {
  it('chk_commands_type ga 6 yangi tur; prompt_templates.big_task; down faqat o\'zinikini olib tashlaydi, up qayta tiklaydi', async () => {
    const own = await createThrowawayDb();
    const { openDataSource } = await import('./helpers.js');
    const d = await openDataSource(own.url);
    try {
      await d.runMigrations();
      const typesOf = async (): Promise<string[]> => {
        const [r] = await d.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`);
        return [...(r.def as string).matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!);
      };
      const NEW = ['deploy.inspect', 'deploy.run', 'deploy.rollback', 'git.checkpoint', 'git.checkpoint_list', 'git.checkpoint_restore'];
      expect(await typesOf()).toEqual(expect.arrayContaining([...NEW, 'logs.tail', 'session.start']));
      expect(await d.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'prompt_templates' AND column_name = 'big_task'`)).toHaveLength(1);
      const latest = async (): Promise<string> => (await d.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`))[0].name as string;
      let guard = 0;
      while ((await latest()) !== 'DeployCheckpoints1731408050000' && guard++ < MIGRATIONS.length) await d.undoLastMigration();
      await d.undoLastMigration();
      const after = await typesOf();
      for (const t of NEW) expect(after).not.toContain(t);
      expect(after).toContain('session.start');
      expect(await d.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'prompt_templates' AND column_name = 'big_task'`)).toHaveLength(0);
      await d.runMigrations();
      expect(await typesOf()).toEqual(expect.arrayContaining(NEW));
    } finally {
      await d.destroy();
      await own.drop();
    }
  });
});

describe('deploy.inspect', () => {
  it('imzolangan dispatch (root va machine DB\'dan, mijoz bermaydi); natija markazda faqat xotirada; 200 + inspect', async () => {
    const a = await newAgent('zz-dp-inspect');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/dp/inspect');
    const pending = postInspect(c.token, p, {}).then((r) => r);
    const d = await answerInspect(a, inspectResult(p.slug));
    expect(d.payload.payload).toEqual({ root: p.path, machine: p.slug });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(DeployInspectResultSchema.parse(res.body.inspect)).toMatchObject({ commit: SHA, recipeHash: HASH, valid: true, machineMatches: { prod: true } });
    const stored = await ds.query(`SELECT payload, result FROM commands WHERE id = $1`, [res.body.commandId]);
    expect(JSON.stringify(stored)).not.toContain('npm run build'); // retsept matni DB'ga tushmaydi (faqat detail)
    expect(stored[0].result).toEqual({ detail: 'valid recipe @ aaaaaaaa' });
    // tokensiz / read-only token
    await http().post(`/v1/projects/${p.id}/deploy/inspect`).send({}).expect(401);
    const ro = await issueToken(['read']);
    await postInspect(ro.token, p).expect(403);
  });

  it('yaroqsiz natija -> 502 invalid_result; agent xatosi (recipe_missing) -> 404; eski agent -> 409 agent_outdated; mijoz tanasida ortiqcha kalit 400', async () => {
    const a = await newAgent('zz-dp-inspect2');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/dp/inspect2');
    const pending = postInspect(c.token, p, {}).then((r) => r);
    await answerInspect(a, { nonsense: true });
    expect((await pending).status).toBe(502);
    const pend2 = postInspect(c.token, p, {}).then((r) => r);
    const d2 = await a.nextOf('command.dispatch');
    a.send(createEnvelope('command.result', { commandId: d2.payload.commandId, state: 'failed', error: { code: 'recipe_missing', message: 'x' } }));
    expect((await pend2).status).toBe(404);
    const old = await newAgent('zz-dp-old', { ...CONTROL, deploy: undefined, allowDeploy: undefined });
    const po = await newProject(old, '/zz/dp/old');
    const r = await postInspect(c.token, po).expect(409);
    expect(r.body.error).toBe('agent_outdated');
    await old.expectNone('command.dispatch');
    await postInspect(c.token, p, { recipe: 'version: 1' }).expect(400); // markaz retsept matnini mijozdan QABUL QILMAYDI
    await postInspect(c.token, p, { commit: 'HEAD; rm -rf' }).expect(400);
  });
});

describe('deploy.run / rollback', () => {
  it('step-up HAR DOIM (Mac dashboard istisnosi ham o\'tmaydi); tasdiqdan oldin dispatch yo\'q; imzolangan payload (target, commit, hash); review + audit', async () => {
    const a = await newAgent('zz-dp-run');
    const c = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    const p = await newProject(a, '/zz/dp/run');
    // istisno ro'yxatiga qo'shamiz: deploy baribir step-up talab qiladi
    await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify([c.id])]);
    const before = stepUpRequests.length;
    try {
      const pending = postRun(c.token, p, RUN).then((r) => r);
      await answerInspect(a, inspectResult(p.slug));
      const res = await pending;
      expect(res.status).toBe(201);
      const cmd = res.body.command as { id: string; status: string; type: string; stepUp: { required: boolean }; promptPreview: string; review?: { required: boolean; reasons: string[] }; cwd: string };
      expect(cmd).toMatchObject({ type: 'deploy.run', status: 'awaiting_confirmation', stepUp: { required: true }, cwd: p.path });
      expect(stepUpRequests.length).toBe(before + 1);
      expect(cmd.promptPreview).toContain('deploy prod @ aaaaaaaa (recipe cccccccc)');
      expect(cmd.promptPreview).toContain('npm run build');
      expect(cmd.review?.reasons.join(' ')).toContain('maqsad prod');
      await a.expectNone('command.dispatch', 300);
      const created = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [cmd.id]);
      expect(created[0].details).toMatchObject({ type: 'deploy.run', target: 'prod', commit: SHA, recipe_hash: HASH, step_up: true });
      expect(JSON.stringify(created[0].details)).not.toContain('npm run build'); // auditda reja matni YO'Q

      const out = await svc(CommandsService).confirm(cmd.id, actorOf(confirmer.id));
      expect(out.outcome).toBe('confirmed');
      const d = await a.nextOf('command.dispatch');
      expect(d.payload).toMatchObject({ commandId: cmd.id, type: 'deploy.run', payload: { root: p.path, machine: p.slug, target: 'prod', recipeHash: HASH, commit: SHA } });
      expect(Object.keys(d.payload.payload as object).sort()).toEqual(['commit', 'machine', 'recipeHash', 'root', 'target']); // reja matni agentga BORMAYDI
      expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
      const audit = (await ds.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY id`, [cmd.id])).map((r: { action: string }) => r.action);
      expect(audit.indexOf('command.dispatched')).toBeGreaterThan(audit.indexOf('command.confirmed'));

      // agent: ack, jonli chiqish, xulosa bilan failed (rolled_back)
      a.send(createEnvelope('command.ack', { commandId: cmd.id }));
      a.send(createEnvelope('logs.chunk', { commandId: cmd.id, seq: 0, lines: ['building', `token=${SECRET}`] }));
      const r1 = (await eventually(async () => (await http().get(`/v1/deploy/runs/${cmd.id}/output?after=0`).set(bearer(c.token))).body, (b: { lines: string[] }) => b.lines.length >= 2)) as { state: string; lines: string[]; nextSeq: number };
      expect(r1).toMatchObject({ state: 'live' });
      expect(r1.lines.join('\n')).not.toContain('ZZZZZZZZ');
      svc(LogsRelayService).sweep(Date.now() + 60_000); // o'quvchisiz ham deploy chiqishi to'xtatilmaydi
      await a.expectNone('logs.stop', 200);
      expect((await http().get(`/v1/deploy/runs/${cmd.id}/output?after=${r1.nextSeq}`).set(bearer(c.token))).body.state).toBe('live');
      a.send(createEnvelope('logs.chunk', { commandId: cmd.id, seq: 1, lines: ['done'], done: true, reason: 'error', error: { code: 'deploy_failed', message: 'rolled_back' } }));
      a.send(createEnvelope('command.result', { commandId: cmd.id, state: 'failed', error: { code: 'deploy_failed', message: 'rolled_back at "build"' }, result: { deploy: SUMMARY({ outcome: 'rolled_back', failedPhase: 'steps', failedStep: 'build' }), detail: 'rolled_back: build' } }));
      await eventually(() => statusOf(cmd.id), (r) => r.status === 'failed');
      const row = (await ds.query(`SELECT status, error_code, result FROM commands WHERE id = $1`, [cmd.id]))[0];
      expect(row).toMatchObject({ status: 'failed', error_code: 'deploy_failed' });
      expect(row.result.deploy).toMatchObject({ outcome: 'rolled_back', failedStep: 'build', rollbackDefined: true });
      const dump = JSON.stringify(await ds.query(`SELECT payload, result, error_message FROM commands WHERE id = $1`, [cmd.id]));
      expect(dump).not.toContain('building'); // chiqish DB'ga tushmaydi
      expect(dump).not.toContain(SECRET);

      // tarix
      const runs = (await http().get(`/v1/projects/${p.id}/deploy/runs`).set(bearer(c.token)).expect(200)).body.items as Array<{ commandId: string; target: string; summary: { outcome: string } | null; status: string }>;
      expect(runs[0]).toMatchObject({ commandId: cmd.id, target: 'prod', status: 'failed', summary: { outcome: 'rolled_back' } });
    } finally {
      await ds.query(`DELETE FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    }
  });

  it('xulosa yaroqsiz bo\'lsa DB\'ga xom `unknown` tushmaydi (done -> failed invalid_result); xulosa bilan done saqlanadi', async () => {
    const a = await newAgent('zz-dp-summary');
    const c = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    const p = await newProject(a, '/zz/dp/summary');
    const go = async (): Promise<string> => {
      const pending = postRun(c.token, p, RUN).then((r) => r);
      await answerInspect(a, inspectResult(p.slug));
      const id = (await pending).body.command.id as string;
      await svc(CommandsService).confirm(id, actorOf(confirmer.id));
      await a.nextOf('command.dispatch');
      a.send(createEnvelope('command.ack', { commandId: id }));
      return id;
    };
    const bad = await go();
    a.send(createEnvelope('command.result', { commandId: bad, state: 'done', result: { deploy: { evil: 'x'.repeat(5000) }, detail: 'ok' } }));
    await eventually(() => statusOf(bad), (r) => r.status === 'failed');
    expect(await statusOf(bad)).toMatchObject({ status: 'failed', error_code: 'invalid_result' });
    expect(JSON.stringify(await ds.query(`SELECT result FROM commands WHERE id = $1`, [bad]))).not.toContain('xxxx');
    const good = await go();
    a.send(createEnvelope('command.result', { commandId: good, state: 'done', result: { deploy: SUMMARY(), detail: 'success in 30s' } }));
    await eventually(() => statusOf(good), (r) => r.status === 'done');
    expect((await ds.query(`SELECT result FROM commands WHERE id = $1`, [good]))[0].result.deploy.outcome).toBe('success');
  });

  it('markaz tekshiruvlari: hash/commit o\'zgargan, iflos, mashina/maqsad mos emas, rollback yo\'q: 409/404/422 va HECH QANDAY buyruq yaratilmaydi', async () => {
    const a = await newAgent('zz-dp-checks');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/dp/checks');
    const n0 = async (): Promise<number> => (await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type IN ('deploy.run','deploy.rollback') AND project_id = $1`, [p.id]))[0].n as number;
    const attempt = async (body: object, ins: unknown, kind: 'run' | 'rollback' = 'run') => {
      const pending = postRun(c.token, p, body, kind).then((r) => r);
      await answerInspect(a, ins);
      return pending;
    };
    expect((await attempt({ ...RUN, recipeHash: 'd'.repeat(64) }, inspectResult(p.slug))).body.error).toBe('recipe_changed');
    expect((await attempt(RUN, inspectResult(p.slug, { commit: 'b'.repeat(40) }))).body.error).toBe('commit_changed');
    expect((await attempt(RUN, inspectResult(p.slug, { dirty: true }))).body.error).toBe('dirty_worktree');
    expect((await attempt(RUN, inspectResult(p.slug, { machineMatches: { prod: false } }))).body.error).toBe('machine_mismatch');
    expect((await attempt({ ...RUN, target: 'staging' }, inspectResult(p.slug))).body.error).toBe('target_not_found');
    expect((await attempt(RUN, inspectResult(p.slug, { valid: false, recipe: null, recipeHash: null, issues: ['bad'] }))).status).toBe(422);
    expect((await attempt(RUN, inspectResult(p.slug, {}, { rollback: [] }), 'rollback')).body.error).toBe('recipe_invalid');
    expect(await n0()).toBe(0);
    // mijoz yaroqsiz tana: inspect'ga umuman bormaydi
    for (const body of [{ ...RUN, recipeHash: 'xyz' }, { ...RUN, commit: '--upload-pack=x' }, { ...RUN, target: 'A B' }, { ...RUN, recipe: 'x' }, { target: 'prod' }]) await postRun(c.token, p, body).expect(400);
    await a.expectNone('command.dispatch', 200);
  });

  it('bir maqsadga bitta deploy: ikkinchi so\'rov 409 deploy_busy (boshqa maqsad/loyiha ta\'sirlanmaydi); lokal siyosat o\'chiq: rejected(action_not_allowed)', async () => {
    const a = await newAgent('zz-dp-busy');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/dp/busy');
    const mk = async () => {
      const pending = postRun(c.token, p, RUN).then((r) => r);
      await answerInspect(a, inspectResult(p.slug));
      return pending;
    };
    expect((await mk()).status).toBe(201);
    const second = await mk();
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('deploy_busy');
    const off = await newAgent('zz-dp-off', { ...CONTROL, allowDeploy: false });
    const po = await newProject(off, '/zz/dp/off');
    const pending = postRun(c.token, po, RUN).then((r) => r);
    await answerInspect(off, inspectResult(po.slug, { allowDeploy: false }));
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.body.command).toMatchObject({ status: 'rejected', errorCode: 'action_not_allowed' });
    await off.expectNone('command.dispatch', 200);
  });

  it('Telegram chat ichidagi aniq tasdiq (`telegram_inline`) rollback uchun ikkinchi so\'rovni almashtiradi; boshqa aktorda e\'tiborsiz; lockdown 403', async () => {
    const a = await newAgent('zz-dp-rb');
    const c = await issueToken(['read', 'control']);
    const tg = await issueToken(['read', 'control'], 'telegram');
    const p = await newProject(a, '/zz/dp/rb');
    const before = stepUpRequests.length;
    const { DeployService } = await import('../../src/deploy/deploy.service.js');
    const pending = svc(DeployService).rollback(p.id, RUN, actorOf(tg.id, { confirmation: 'telegram_inline' }), 'tg-rb-test-1');
    await answerInspect(a, inspectResult(p.slug));
    const res = await pending;
    expect(res.command).toMatchObject({ type: 'deploy.rollback', status: 'sent' });
    expect(stepUpRequests.length).toBe(before); // chat ichidagi karta tasdig'i
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'deploy.rollback', payload: { target: 'prod', commit: SHA, recipeHash: HASH } });
    const conf = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.confirmed' AND target = $1`, [res.command.id]);
    expect(conf[0].details).toMatchObject({ confirmation: 'telegram_inline' });

    // REST aktori `confirmation` bera olmaydi (controller o'rnatmaydi): step-up so'raladi
    const p2 = await newProject(a, '/zz/dp/rb2');
    const pend2 = postRun(c.token, p2, RUN, 'rollback').then((r) => r);
    await answerInspect(a, inspectResult(p2.slug));
    expect((await pend2).body.command).toMatchObject({ status: 'awaiting_confirmation' });

    await svc(LockdownService).set(true, 'test');
    try {
      await postRun(c.token, p, RUN).expect(403);
      await postRun(c.token, p, RUN, 'rollback').expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });
});

describe('git checkpoint', () => {
  const CK = { ref: 'refs/commander/checkpoints/20261114T100000Z-big', sha: SHA, label: 'big', createdAt: '2026-11-14T10:00:00.000Z', headSha: SHA, branch: 'main', auto: false, untracked: 1 };

  it('yaratish: imzolangan dispatch (root DB\'dan), step-up YO\'Q; ro\'yxat; yaroqsiz label/ref 400; natija xotirada', async () => {
    const a = await newAgent('zz-ck-create');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/ck/create');
    const before = stepUpRequests.length;
    const pending = http().post(`/v1/projects/${p.id}/checkpoints`).set(bearer(c.token)).send({ label: 'before big task' }).then((r) => r);
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'git.checkpoint', payload: { root: p.path, label: 'before big task' } });
    expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
    const id = d.payload.commandId as string;
    a.send(createEnvelope('command.ack', { commandId: id }));
    a.send(createEnvelope('command.result', { commandId: id, state: 'done', result: { checkpoint: { checkpoint: CK, clean: false, untrackedSkipped: 2 }, detail: 'x' } }));
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.body.result).toMatchObject({ checkpoint: { ref: CK.ref }, clean: false, untrackedSkipped: 2 });
    expect(stepUpRequests.length).toBe(before);

    const pend2 = http().post(`/v1/projects/${p.id}/checkpoints/list`).set(bearer(c.token)).send({}).then((r) => r);
    const d2 = await a.nextOf('command.dispatch');
    expect(d2.payload).toMatchObject({ type: 'git.checkpoint_list', payload: { root: p.path } });
    a.send(createEnvelope('command.ack', { commandId: d2.payload.commandId }));
    a.send(createEnvelope('command.result', { commandId: d2.payload.commandId, state: 'done', result: { checkpoint: { items: [CK], total: 1 } } }));
    const lr = await pend2;
    expect(lr.status).toBe(200);
    expect(lr.body.result).toMatchObject({ total: 1, items: [{ label: 'big' }] });

    for (const label of ['--evil', 'a\nb', '', 'x'.repeat(61)]) await http().post(`/v1/projects/${p.id}/checkpoints`).set(bearer(c.token)).send({ label }).expect(400);
    for (const ref of ['refs/heads/main', 'HEAD', `${CK.ref}/../../heads/main`, `${CK.ref} --force`]) await http().post(`/v1/projects/${p.id}/checkpoints/restore`).set(bearer(c.token)).send({ ref }).expect(400);
    await a.expectNone('command.dispatch', 200);
    const ro = await issueToken(['read']);
    await http().post(`/v1/projects/${p.id}/checkpoints`).set(bearer(ro.token)).send({ label: 'x' }).expect(403);
  });

  it('qaytarish: step-up (Telegram), tasdiqdan oldin dispatch yo\'q, imzolangan payload (ref); natija xotirada; audit', async () => {
    const a = await newAgent('zz-ck-restore');
    const c = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    const p = await newProject(a, '/zz/ck/restore');
    const before = stepUpRequests.length;
    const res = await http().post(`/v1/projects/${p.id}/checkpoints/restore`).set(bearer(c.token)).send({ ref: CK.ref }).expect(201);
    expect(res.body.command).toMatchObject({ type: 'git.checkpoint_restore', status: 'awaiting_confirmation', stepUp: { required: true } });
    expect(stepUpRequests.length).toBe(before + 1);
    expect(res.body.command.promptPreview).toContain('pre-restore');
    await a.expectNone('command.dispatch', 300);
    expect((await svc(CommandsService).confirm(res.body.command.id, actorOf(confirmer.id))).outcome).toBe('confirmed');
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'git.checkpoint_restore', payload: { root: p.path, ref: CK.ref } });
    expect(verifyDispatch(a.centerKey, a.deviceId, d)).toBe(true);
    a.send(createEnvelope('command.ack', { commandId: res.body.command.id }));
    const restored = { restored: CK.ref, preRestore: { ...CK, ref: 'refs/commander/checkpoints/20261114T100500Z-pre-restore', label: 'pre-restore', auto: true }, headSha: SHA, headMoved: false, branch: 'main' };
    a.send(createEnvelope('command.result', { commandId: res.body.command.id, state: 'done', result: { checkpoint: restored, detail: 'restored' } }));
    await eventually(() => statusOf(res.body.command.id), (r) => r.status === 'done');
    const { CheckpointsService } = await import('../../src/deploy/checkpoints.service.js');
    expect(svc(CheckpointsService).restoreResult(res.body.command.id)).toMatchObject({ headMoved: false, preRestore: { auto: true } });
    const created = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [res.body.command.id]);
    expect(created[0].details).toMatchObject({ type: 'git.checkpoint_restore', ref: CK.ref, step_up: true });
  });

  it('lokal siyosat: yozish ruxsatsiz agent -> create/restore rad, list ishlaydi; eski agent -> agent_outdated', async () => {
    const c = await issueToken(['read', 'control']);
    const ro = await newAgent('zz-ck-ro', { ...CONTROL, allowProjectWrite: false });
    const p = await newProject(ro, '/zz/ck/ro');
    const r = await http().post(`/v1/projects/${p.id}/checkpoints`).set(bearer(c.token)).send({ label: 'x' }).expect(403);
    expect(r.body.error).toBe('action_not_allowed');
    const old = await newAgent('zz-ck-old', { ...CONTROL, checkpoints: undefined });
    const po = await newProject(old, '/zz/ck/old');
    expect((await http().post(`/v1/projects/${po.id}/checkpoints/list`).set(bearer(c.token)).send({}).expect(409)).body.error).toBe('agent_outdated');
    await ro.expectNone('command.dispatch', 200);
  });

  it('avto-checkpoint: sozlama o\'chiq = yo\'q; yoqilganda session.start{checkpoint:true} oldidan git.checkpoint (auto, loyiha cwd bo\'yicha); bayroq buyruqqa kirmaydi; best-effort', async () => {
    const a = await newAgent('zz-ck-auto');
    const c = await issueToken(['read', 'control']);
    const p = await newProject(a, '/zz/ck/auto');
    const start = { type: 'session.start', machineId: a.machineId, cwd: '/zz/ck/auto/sub', prompt: 'big job', permissionMode: 'plan', checkpoint: true };
    // sozlama o'chiq (default)
    expect((await http().get('/v1/checkpoints/settings').set(bearer(c.token)).expect(200)).body).toEqual({ bigTask: false, orchestration: false });
    const r0 = await http().post('/v1/commands').set(bearer(c.token)).send(start).expect(201);
    expect(JSON.stringify(r0.body.command.payload ?? {})).not.toContain('checkpoint');
    await a.expectNone('command.dispatch', 300); // step-up kutadi, checkpoint ham yo'q
    // yoqamiz
    await http().put('/v1/checkpoints/settings').set(bearer(c.token)).send({ bigTask: true, orchestration: false }).expect(200);
    const pending = http().post('/v1/commands').set(bearer(c.token)).send({ ...start, prompt: 'big job 2' }).then((r) => r);
    const d = await a.nextOf('command.dispatch');
    expect(d.payload).toMatchObject({ type: 'git.checkpoint', payload: { root: p.path, auto: true } });
    expect((d.payload.payload as { label: string }).label).toMatch(/^auto /);
    a.send(createEnvelope('command.ack', { commandId: d.payload.commandId }));
    a.send(createEnvelope('command.result', { commandId: d.payload.commandId, state: 'done', result: { checkpoint: { checkpoint: { ...CK, auto: true }, clean: true, untrackedSkipped: 0 } } }));
    expect((await pending).status).toBe(201); // session.start step-up kutayotgan buyruq yaratildi
    // checkpoint rad etilsa ham session.start davom etadi (best-effort); loyiha yo'q cwd: checkpoint yo'q
    const pend3 = http().post('/v1/commands').set(bearer(c.token)).send({ ...start, cwd: '/elsewhere', prompt: 'big job 3' }).then((r) => r);
    expect((await pend3).status).toBe(201);
    await a.expectNone('command.dispatch', 300);
    await http().put('/v1/checkpoints/settings').set(bearer(c.token)).send({ bigTask: 'yes' }).expect(400);
    await http().put('/v1/checkpoints/settings').set(bearer(c.token)).send({ bigTask: false, orchestration: false }).expect(200);
  });

  it('shablon big_task bayrog\'i saqlanadi va qaytadi', async () => {
    const c = await issueToken(['read', 'control']);
    const t = await http().post('/v1/templates').set(bearer(c.token)).send({ scope: 'global', name: `zz-big-${randomBytes(2).toString('hex')}`, body: 'Do {{task_title}}', bigTask: true }).expect(201);
    expect(t.body.bigTask).toBe(true);
    const u = await http().patch(`/v1/templates/${t.body.id}`).set(bearer(c.token)).send({ bigTask: false }).expect(200);
    expect(u.body.bigTask).toBe(false);
    const plain = await http().post('/v1/templates').set(bearer(c.token)).send({ scope: 'global', name: `zz-plain-${randomBytes(2).toString('hex')}`, body: 'x' }).expect(201);
    expect(plain.body.bigTask).toBe(false);
  });
});
