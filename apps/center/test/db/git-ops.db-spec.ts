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
  CreateCommandResponseSchema,
  DiffResponseSchema,
  ProjectGitResponseSchema,
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
import { gitNotifications } from '../../src/projects/git-notify.js';
import type { GitNotice } from '../../src/projects/git-notify.js';
import { GitOpsService } from '../../src/projects/git-ops.service.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 3.5 (center tomoni): diff (loyiha/sessiya), PR ochish (step-up), CI holati (davriy + talab), commit->vazifa bog'lash.
 * Soxta agent, haqiqiy imzolangan dispatch, haqiqiy TimescaleDB + `ws`.
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

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, projectOps: true, allowProjectRead: true, allowProjectWrite: true, gitOps: true };
const CONTROL_NOGIT = { ...CONTROL_ON, gitOps: undefined };
const CONTROL_NOWRITE = { ...CONTROL_ON, allowProjectWrite: false };

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

const PATH = '/zz/git/proj';
const SHA_START = 'c'.repeat(40);

async function agentRun(a: Agent, commandId: string, finish: { state: 'done' | 'failed'; result?: unknown; error?: { code: string; message: string } }): Promise<void> {
  a.send(createEnvelope('command.ack', { commandId }));
  await eventually(async () => (await ds.query(`SELECT status FROM commands WHERE id = $1`, [commandId]))[0].status, (s) => s === 'acked');
  const env = createEnvelope('command.result', { commandId, ...finish });
  a.send(env);
  await a.nextWhere((m) => m.type === 'ack' && (m.payload.ids as string[]).includes(env.id));
}

const DIFF = (extra: Record<string, unknown> = {}) => ({
  base: 'HEAD',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  branch: 'feat/3.5-x',
  files: [{ path: 'src/a.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1, binary: false, patch: 'diff --git a/src/a.ts b/src/a.ts\n+SECRET_PATCH_LINE\n', truncated: false, hidden: null }],
  filesTotal: 1,
  totalAdditions: 2,
  totalDeletions: 1,
  untracked: ['notes.txt'],
  untrackedTotal: 1,
  bytes: 60,
  truncated: false,
  ...extra,
});

const CI = (over: Record<string, unknown> = {}) => ({
  branch: 'feat/3.5-x',
  state: 'failure',
  pr: { number: 42, url: 'https://github.com/acme/app/pull/42', state: 'open', title: 'Add feature', draft: false },
  checks: [{ name: 'build', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/9' }, { name: 'lint', bucket: 'pass', link: null }],
  run: { id: '9', name: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/app/actions/runs/9', headSha: 'd'.repeat(40) },
  ...over,
});

describe('3.5 Git/PR', () => {
  let agent: Agent;
  let projectId = '';
  let ctl: { id: string; token: string };
  let reader = '';
  const notices: GitNotice[] = [];
  let unsub: () => void;

  beforeAll(async () => {
    unsub = gitNotifications.subscribe((n) => void notices.push(n));
    agent = await newAgent('zz-git');
    ctl = await issue(['read', 'control']);
    reader = (await issue(['read'])).token;
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, { hash: HASH(1), takenAt: T('2026-11-05T05:00:00Z'), headSha: 'a'.repeat(40), branch: 'main', tasksMd: '# T\n\n## Faza 1\n\n| # | Task | Hajm |\n|---|---|---|\n| 3.4 | Shablonlar | M |\n| 3.5 | Git/PR | M |\n', tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(9), commits: [{ sha: '1'.repeat(40), subject: 'init', author: 'Ali', ts: T('2026-11-05T04:00:00Z') }] })));
    const [p] = await ds.query(`SELECT id FROM projects WHERE path = $1`, [PATH]);
    projectId = p.id as string;
  }, 60_000);
  afterAll(() => unsub());

  it('migratsiya: jadvallar, sessions.start_head_sha va commands turlari', async () => {
    const t: Array<{ table_name: string }> = await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('project_prs','project_ci_status','task_commits')`);
    expect(t.map((x) => x.table_name).sort()).toEqual(['project_ci_status', 'project_prs', 'task_commits']);
    await expect(ds.query(`UPDATE sessions SET start_head_sha = 'zzz' WHERE false`)).resolves.toBeDefined();
    const def: Array<{ def: string }> = await ds.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_commands_type'`);
    for (const ty of ['project.diff', 'project.open_pr', 'project.ci_status', 'project.summarize']) expect(def[0]!.def).toContain(ty);
  });

  it('commit -> vazifa: #task:, [id], branch taxmini (faqat yangi commit); qayta yuborish takror yaratmaydi', async () => {
    const c = (sha: string, subject: string, ts: string) => ({ sha: sha.repeat(40), subject, author: 'Ali', ts: T(ts) });
    const tasksMd = '# T\n\n## Faza 1\n\n| # | Task | Hajm |\n|---|---|---|\n| 3.4 | Shablonlar | M |\n| 3.5 | Git/PR | M |\n';
    const base = { tasksMd, tasksPath: 'docs/TASKS.md', tasksMdHash: HASH(9), branch: 'feat/3.5-git' };
    const old = c('1', 'init', '2026-11-05T04:00:00Z');
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, {
      ...base, hash: HASH(2), takenAt: T('2026-11-05T06:00:00Z'), headSha: '2'.repeat(40),
      commits: [c('2', '[3.4] shablon ro\'yxati', '2026-11-05T05:30:00Z'), c('3', 'fix #task:3.5 diff parser', '2026-11-05T05:40:00Z'), c('4', '[9.9] noma\'lum vazifa', '2026-11-05T05:50:00Z'), old],
    })));
    // 2-snapshot: yangi commit "wip" branch (feat/3.5-git) ga taxminan bog'lanadi; `init` eski: bog'lanmaydi
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, {
      ...base, hash: HASH(3), takenAt: T('2026-11-05T07:00:00Z'), headSha: '5'.repeat(40),
      commits: [c('5', 'wip: davom', '2026-11-05T06:50:00Z'), c('2', '[3.4] shablon ro\'yxati', '2026-11-05T05:30:00Z'), c('3', 'fix #task:3.5 diff parser', '2026-11-05T05:40:00Z'), c('4', '[9.9] noma\'lum vazifa', '2026-11-05T05:50:00Z'), old],
    })));
    // takror: bir xil snapshot qayta yuborildi
    await roundtrip(agent, createEnvelope('agent.project_snapshot', snap(PATH, {
      ...base, hash: HASH(3), takenAt: T('2026-11-05T07:00:00Z'), headSha: '5'.repeat(40),
      commits: [c('5', 'wip: davom', '2026-11-05T06:50:00Z'), c('2', '[3.4] shablon ro\'yxati', '2026-11-05T05:30:00Z'), c('3', 'fix #task:3.5 diff parser', '2026-11-05T05:40:00Z'), c('4', '[9.9] noma\'lum vazifa', '2026-11-05T05:50:00Z'), old],
    })));
    const rows: Array<{ sha: string; task_key: string; source: string }> = await ds.query(`SELECT sha, task_key, source FROM task_commits WHERE project_id = $1 ORDER BY sha`, [projectId]);
    expect(rows.map((r) => [r.sha[0], r.task_key, r.source])).toEqual([
      ['2', '3.4', 'subject'],
      ['3', '3.5', 'subject'],
      ['4', '3.5', 'branch'], // [9.9] noma'lum vazifa: aniq ishora hisobga olinmaydi, yangi commit branch'ga taxmin
      ['5', '3.5', 'branch'],
    ]);
    const git = ProjectGitResponseSchema.parse((await http().get(`/v1/projects/${projectId}/git`).set(bearer(reader)).expect(200)).body);
    expect(git.taskCommits.map((x) => [x.sha[0], x.taskKey, x.source]).sort()).toEqual([['2', '3.4', 'subject'], ['3', '3.5', 'subject'], ['4', '3.5', 'branch'], ['5', '3.5', 'branch']]);
    await http().get(`/v1/projects/${projectId}/git`).expect(401);
    await http().get(`/v1/projects/${randomUUID()}/git`).set(bearer(reader)).expect(404);
  });

  it('SessionStart headSha: birinchisi saqlanadi (keyingisi o\'zgartirmaydi); sxema sha\'ni tekshiradi', async () => {
    const S = 'gs-1';
    await roundtrip(agent, createEnvelope('agent.events', { events: [ev(S, 'SessionStart', 'idle', '2026-11-05T08:00:00Z', PATH, { headSha: SHA_START })] }));
    await roundtrip(agent, createEnvelope('agent.events', { events: [ev(S, 'SessionStart', 'idle', '2026-11-05T09:00:00Z', PATH, { headSha: 'e'.repeat(40) })] }));
    const [s] = await ds.query(`SELECT start_head_sha FROM sessions WHERE machine_id = $1 AND claude_session_id = $2`, [agent.machineId, S]);
    expect(s.start_head_sha).toBe(SHA_START);
    const bad = createEnvelope('agent.events', { events: [ev('gs-bad', 'SessionStart', 'idle', '2026-11-05T09:00:00Z', PATH, { headSha: 'not-a-sha;rm' })] });
    agent.send(bad);
    const r = await agent.nextWhere((m) => (m.type === 'ack' && (m.payload.ids as string[]).includes(bad.id)) || (m.type === 'nack' && m.payload.id === bad.id), 5000);
    expect(r.type).toBe('nack');
  });

  describe('diff', () => {
    it('loyiha diff: control scope; imzolangan project.diff; natija xotirada (DB\'da patch YO\'Q); audit', async () => {
      await http().post(`/v1/projects/${projectId}/diff`).set(bearer(reader)).send({}).expect(403);
      await http().post(`/v1/projects/${projectId}/diff`).send({}).expect(401);
      await http().post(`/v1/projects/${projectId}/diff`).set(bearer(ctl.token)).send({ base: '--output=/tmp/x' }).expect(400);
      await http().post(`/v1/projects/${projectId}/diff`).set(bearer(ctl.token)).send({ extra: 1 }).expect(400);
      await http().post(`/v1/projects/${randomUUID()}/diff`).set(bearer(ctl.token)).send({}).expect(404);

      const pending = http().post(`/v1/projects/${projectId}/diff`).set(bearer(ctl.token)).send({ base: 'merge-base:main' }).then((r) => r);
      const d = await agent.nextOf('command.dispatch');
      expect(d.payload).toMatchObject({ type: 'project.diff', payload: { root: PATH, base: 'merge-base:main' } });
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { diff: DIFF() } });
      const res = await pending;
      expect(res.status).toBe(200);
      const out = DiffResponseSchema.parse(res.body);
      expect(out).toMatchObject({ projectId, sessionId: null, baseSource: 'explicit', commandId: d.payload.commandId });
      expect(out.diff.files[0]!.patch).toContain('SECRET_PATCH_LINE');
      const [row] = await ds.query(`SELECT payload::text AS p, result::text AS r, status FROM commands WHERE id = $1`, [d.payload.commandId]);
      expect(row.status).toBe('done');
      expect(`${row.p}${row.r}`).not.toContain('SECRET_PATCH_LINE');
      expect(row.r).toContain('1 files +2 -1');
      const audit = await ds.query(`SELECT action FROM audit_log WHERE target = $1`, [d.payload.commandId]);
      expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['command.created', 'command.dispatched', 'command.result']));
    });

    it('yaroqsiz diff natijasi: invalid_result (502), buyruq failed; agent xatosi HTTP xatoga', async () => {
      const p1 = http().post(`/v1/projects/${projectId}/diff`).set(bearer(ctl.token)).send({}).then((r) => r);
      const d1 = await agent.nextOf('command.dispatch');
      await agentRun(agent, d1.payload.commandId as string, { state: 'done', result: { diff: { files: 'x' } } });
      const r1 = await p1;
      expect(r1.status).toBe(502);
      expect(r1.body.error).toBe('invalid_result');

      const p2 = http().post(`/v1/projects/${projectId}/diff`).set(bearer(ctl.token)).send({}).then((r) => r);
      const d2 = await agent.nextOf('command.dispatch');
      await agentRun(agent, d2.payload.commandId as string, { state: 'failed', error: { code: 'not_a_git_repo', message: 'x' } });
      const r2 = await p2;
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe('not_a_git_repo');
    });

    it('sessiya diff: baza = SessionStart HEAD (session_start); yo\'q bo\'lsa snapshot HEAD; undan ham yo\'q = HEAD', async () => {
      const [s1] = await ds.query(`SELECT id FROM sessions WHERE machine_id = $1 AND claude_session_id = 'gs-1'`, [agent.machineId]);
      const p1 = http().post(`/v1/sessions/${s1.id}/diff`).set(bearer(ctl.token)).send({ statOnly: true }).then((r) => r);
      const d1 = await agent.nextOf('command.dispatch');
      expect(d1.payload).toMatchObject({ type: 'project.diff', payload: { root: PATH, base: SHA_START, statOnly: true } });
      await agentRun(agent, d1.payload.commandId as string, { state: 'done', result: { diff: DIFF({ baseSha: SHA_START }) } });
      expect(DiffResponseCheck((await p1).body)).toMatchObject({ sessionId: s1.id, baseSource: 'session_start' });

      // start_head_sha yo'q sessiya, started_at dan oldingi snapshot HEAD'i bor
      await roundtrip(agent, createEnvelope('agent.events', { events: [ev('gs-2', 'SessionStart', 'idle', '2026-11-05T06:30:00Z', PATH)] }));
      const [s2] = await ds.query(`SELECT id FROM sessions WHERE machine_id = $1 AND claude_session_id = 'gs-2'`, [agent.machineId]);
      await ds.query(`UPDATE sessions SET started_at = $2 WHERE id = $1`, [s2.id, '2026-11-05T06:30:00Z']);
      const p2 = http().post(`/v1/sessions/${s2.id}/diff`).set(bearer(ctl.token)).send({}).then((r) => r);
      const d2 = await agent.nextOf('command.dispatch');
      expect(d2.payload).toMatchObject({ payload: { base: '2'.repeat(40) } }); // 06:00 snapshot headSha
      await agentRun(agent, d2.payload.commandId as string, { state: 'done', result: { diff: DIFF() } });
      expect(DiffResponseCheck((await p2).body).baseSource).toBe('snapshot');

      await roundtrip(agent, createEnvelope('agent.events', { events: [ev('gs-3', 'SessionStart', 'idle', '2026-11-05T01:00:00Z', PATH)] }));
      const [s3] = await ds.query(`SELECT id FROM sessions WHERE machine_id = $1 AND claude_session_id = 'gs-3'`, [agent.machineId]);
      await ds.query(`UPDATE sessions SET started_at = $2 WHERE id = $1`, [s3.id, '2026-11-05T01:00:00Z']);
      const p3 = http().post(`/v1/sessions/${s3.id}/diff`).set(bearer(ctl.token)).send({}).then((r) => r);
      const d3 = await agent.nextOf('command.dispatch');
      expect(d3.payload).toMatchObject({ payload: { base: 'HEAD' } });
      await agentRun(agent, d3.payload.commandId as string, { state: 'done', result: { diff: DIFF() } });
      expect(DiffResponseCheck((await p3).body).baseSource).toBe('head');
      await http().post(`/v1/sessions/${randomUUID()}/diff`).set(bearer(ctl.token)).send({}).expect(404);
    });

    it('sessiya loyihaga bog\'lanmagan: 409 no_project', async () => {
      await roundtrip(agent, createEnvelope('agent.events', { events: [ev('gs-np', 'SessionStart', 'idle', '2026-11-05T01:00:00Z', '/zz/other/np')] }));
      const [s] = await ds.query(`SELECT id, project_id FROM sessions WHERE machine_id = $1 AND claude_session_id = 'gs-np'`, [agent.machineId]);
      await ds.query(`UPDATE sessions SET project_id = NULL WHERE id = $1`, [s.id]);
      const r = await http().post(`/v1/sessions/${s.id}/diff`).set(bearer(ctl.token)).send({}).expect(409);
      expect(r.body.error).toBe('no_project');
    });

    it('eski agentd (gitOps yo\'q): agent_outdated -> 409; yozish ruxsatsiz agent: PR rad, diff ishlaydi', async () => {
      const old = await newAgent('zz-git-old', CONTROL_NOGIT);
      const [op] = await ds.query(`INSERT INTO projects (machine_id, path, name, kind) VALUES ($1, '/zz/old/p', 'p', 'git') RETURNING id`, [old.machineId]);
      const r = await http().post(`/v1/projects/${op.id}/diff`).set(bearer(ctl.token)).send({}).expect(409);
      expect(r.body.error).toBe('agent_outdated');

      const nw = await newAgent('zz-git-nowrite', CONTROL_NOWRITE);
      const [np] = await ds.query(`INSERT INTO projects (machine_id, path, name, kind) VALUES ($1, '/zz/nw/p', 'p', 'git') RETURNING id`, [nw.machineId]);
      const pr = CreateCommandResponseSchema.parse((await http().post(`/v1/projects/${np.id}/pr`).set(bearer(ctl.token)).send({ title: 't', body: 'b', base: 'main', draft: false }).expect(201)).body);
      expect(pr.command).toMatchObject({ status: 'rejected', errorCode: 'action_not_allowed' });
    });
  });

  describe('PR ochish', () => {
    const body = { title: 'Add feature', body: 'Body\nline2', base: 'main', head: 'feat/3.5-x', draft: false };

    it('validatsiya va scope', async () => {
      await http().post(`/v1/projects/${projectId}/pr`).set(bearer(reader)).send(body).expect(403);
      await http().post(`/v1/projects/${projectId}/pr`).send(body).expect(401);
      for (const bad of [{ ...body, base: '--web' }, { ...body, title: 'a\nb' }, { ...body, head: 'a..b' }, { ...body, extra: 1 }, { ...body, title: '' }, { title: 't', body: 'b', draft: false }]) {
        await http().post(`/v1/projects/${projectId}/pr`).set(bearer(ctl.token)).send(bad).expect(400);
      }
      await http().post(`/v1/projects/${randomUUID()}/pr`).set(bearer(ctl.token)).send(body).expect(404);
    });

    it('step-up majburiy: Telegram tasdig\'idan keyin dispatch; natija project_prs ga; sarlavha DB\'da redakt, tana matni YO\'Q', async () => {
      stepUpRequests.length = 0;
      const created = CreateCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/pr`).set(bearer(ctl.token)).send({ ...body, title: 'Add token=sk-ant-abcdefghijklmnop feature', body: 'BODY_SECRET_TEXT' }).expect(201)).body);
      expect(created.command).toMatchObject({ type: 'project.open_pr', status: 'awaiting_confirmation', stepUp: { required: true } });
      expect(stepUpRequests.map((c) => c.id)).toContain(created.command.id);
      await agent.expectNone('command.dispatch', 200);

      const tg = await issue(['read', 'control', 'approve'], 'telegram');
      const confirmed = await svc(CommandsService).confirm(created.command.id, actorOf(tg.id));
      expect(confirmed.outcome).toBe('confirmed');
      const d = await agent.nextOf('command.dispatch');
      expect(d.payload).toMatchObject({ type: 'project.open_pr', payload: { root: PATH, base: 'main', head: 'feat/3.5-x', draft: false, body: 'BODY_SECRET_TEXT' } });
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { pr: { url: 'https://github.com/acme/app/pull/42', number: 42, existing: false, branch: 'feat/3.5-x', base: 'main', draft: false, pushed: true } } });

      const [pr] = await ds.query(`SELECT number, url, title, branch, base, state, opened_via, opened_by_device_id FROM project_prs WHERE project_id = $1`, [projectId]);
      expect(pr).toMatchObject({ number: 42, url: 'https://github.com/acme/app/pull/42', branch: 'feat/3.5-x', base: 'main', state: 'open' });
      expect(pr.title).not.toContain('sk-ant-abcdefghijklmnop');
      const [row] = await ds.query(`SELECT payload::text AS p, result::text AS r, status FROM commands WHERE id = $1`, [created.command.id]);
      expect(row.status).toBe('done');
      expect(`${row.p}${row.r}`).not.toContain('BODY_SECRET_TEXT');
      expect(row.r).toContain('pull/42');
      const git = ProjectGitResponseSchema.parse((await http().get(`/v1/projects/${projectId}/git`).set(bearer(reader)).expect(200)).body);
      expect(git.prs[0]).toMatchObject({ number: 42, state: 'open', branch: 'feat/3.5-x' });
    });

    it('Telegram inline tasdig\'i step-up\'ni almashtiradi (audit: confirmation=telegram_inline); boshqa aktorlar uchun e\'tiborsiz', async () => {
      stepUpRequests.length = 0;
      const tg = await issue(['read', 'control', 'approve'], 'telegram');
      const inline = await svc(CommandsService).create({ type: 'project.open_pr', projectId, ...body, title: 'Inline PR' }, { deviceId: tg.id, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' }, undefined);
      expect(inline.command.status).toBe('sent');
      expect(inline.command.stepUp.required).toBe(false);
      expect(stepUpRequests).toHaveLength(0);
      const d = await agent.nextOf('command.dispatch');
      await agentRun(agent, d.payload.commandId as string, { state: 'failed', error: { code: 'dirty_worktree', message: 'uncommitted' } });
      const audit = await ds.query(`SELECT action FROM audit_log WHERE target = $1`, [inline.command.id]);
      expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['command.created', 'command.confirmed', 'command.dispatched']));

      // 'web' aktor confirmation bilan ham step-up kerak
      const web = await svc(CommandsService).create({ type: 'project.open_pr', projectId, ...body, title: 'Web PR' }, { deviceId: ctl.id, actorKind: 'web', ip: null, confirmation: 'telegram_inline' }, undefined);
      expect(web.command.status).toBe('awaiting_confirmation');
      await svc(CommandsService).cancel(web.command.id, actorOf(tg.id));
    });

    it('natija sxemaga mos kelmasa: failed(invalid_result), PR yozilmaydi', async () => {
      const tg = await issue(['read', 'control', 'approve'], 'telegram');
      const c = await svc(CommandsService).create({ type: 'project.open_pr', projectId, ...body, title: 'Bad result' }, { deviceId: tg.id, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' }, undefined);
      const d = await agent.nextOf('command.dispatch');
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { pr: { url: 'javascript:alert(1)', number: 1 } } });
      const dto = await svc(CommandsService).getDto(c.command.id);
      expect(dto).toMatchObject({ status: 'failed', errorCode: 'invalid_result' });
      expect((await ds.query(`SELECT count(*)::int AS n FROM project_prs WHERE project_id = $1`, [projectId]))[0].n).toBe(1);
    });
  });

  describe('CI holati', () => {
    it('refresh: control scope; natija project_ci_status ga; Commander PR\'i uchun muvaffaqiyatsizlik bildirishi bir run uchun bir marta', async () => {
      notices.length = 0;
      await http().post(`/v1/projects/${projectId}/ci/refresh`).set(bearer(reader)).send({}).expect(403);
      await http().post(`/v1/projects/${projectId}/ci/refresh`).set(bearer(ctl.token)).send({ branch: '-x' }).expect(400);

      const run = async (ci: unknown): Promise<void> => {
        const r = CreateCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/ci/refresh`).set(bearer(ctl.token)).send({ branch: 'feat/3.5-x' }).expect(201)).body);
        expect(r.command).toMatchObject({ type: 'project.ci_status', status: 'sent' });
        const d = await agent.nextOf('command.dispatch');
        expect(d.payload).toMatchObject({ type: 'project.ci_status', payload: { root: PATH, branch: 'feat/3.5-x' } });
        await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { ci } });
      };
      await run(CI());
      const [st] = await ds.query(`SELECT state, pr_number, run_id, failed_notified_run_id FROM project_ci_status WHERE project_id = $1 AND branch = 'feat/3.5-x'`, [projectId]);
      expect(st).toMatchObject({ state: 'failure', pr_number: 42, run_id: '9', failed_notified_run_id: '9' });
      await eventually(async () => notices.length, (n) => n >= 1);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.notice).toMatchObject({ projectId, branch: 'feat/3.5-x', prNumber: 42, runName: 'CI', failing: ['build'] });

      // xuddi shu run: qayta bildirilmaydi
      await run(CI());
      await sleep(150);
      expect(notices).toHaveLength(1);
      // yangi muvaffaqiyatsiz run: yana bir marta
      await run(CI({ run: { id: '10', name: 'CI', status: 'completed', conclusion: 'failure', url: null, headSha: null } }));
      await eventually(async () => notices.length, (n) => n >= 2);
      expect(notices).toHaveLength(2);
      // muvaffaqiyat: bildirish yo'q, holat yangilanadi
      await run(CI({ state: 'success', checks: [{ name: 'build', bucket: 'pass', link: null }], run: { id: '11', name: 'CI', status: 'completed', conclusion: 'success', url: null, headSha: null } }));
      expect((await ds.query(`SELECT state FROM project_ci_status WHERE project_id = $1`, [projectId]))[0].state).toBe('success');
      expect(notices).toHaveLength(2);
      const git = ProjectGitResponseSchema.parse((await http().get(`/v1/projects/${projectId}/git`).set(bearer(reader)).expect(200)).body);
      expect(git.ci[0]).toMatchObject({ branch: 'feat/3.5-x', state: 'success', prNumber: 42 });
    });

    it('Commander ochmagan PR (project_prs yo\'q) uchun bildirish yo\'q', async () => {
      notices.length = 0;
      const r = CreateCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/ci/refresh`).set(bearer(ctl.token)).send({ branch: 'other/branch' }).expect(201)).body);
      expect(r.command.status).toBe('sent');
      const d = await agent.nextOf('command.dispatch');
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { ci: CI({ branch: 'other/branch', pr: null }) } });
      await sleep(150);
      expect(notices).toHaveLength(0);
      expect((await ds.query(`SELECT state FROM project_ci_status WHERE project_id = $1 AND branch = 'other/branch'`, [projectId]))[0].state).toBe('failure');
    });

    it('PR merged bo\'lsa project_prs.state yangilanadi va davriy so\'rov to\'xtaydi', async () => {
      const r = CreateCommandResponseSchema.parse((await http().post(`/v1/projects/${projectId}/ci/refresh`).set(bearer(ctl.token)).send({ branch: 'feat/3.5-x' }).expect(201)).body);
      expect(r.command.status).toBe('sent');
      const d = await agent.nextOf('command.dispatch');
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { ci: CI({ state: 'success', checks: [], pr: { number: 42, url: 'https://github.com/acme/app/pull/42', state: 'merged', title: 'x', draft: false } }) } });
      expect((await ds.query(`SELECT state FROM project_prs WHERE project_id = $1 AND number = 42`, [projectId]))[0].state).toBe('merged');
      expect(await svc(GitOpsService).pollCi()).toBe(0);
    });

    it('pollCi: ochiq PR + online mashina uchun buyruq yaratadi (system aktori), bir oynada takror yaratmaydi', async () => {
      await ds.query(`UPDATE project_prs SET state = 'open' WHERE project_id = $1 AND number = 42`, [projectId]);
      const now = new Date();
      const n1 = await svc(GitOpsService).pollCi(now);
      expect(n1).toBe(1);
      const d = await agent.nextOf('command.dispatch');
      expect(d.payload).toMatchObject({ type: 'project.ci_status', payload: { root: PATH, branch: 'feat/3.5-x' } });
      // buyruq hali ochiq: qayta yaratilmaydi
      expect(await svc(GitOpsService).pollCi(now)).toBe(0);
      await agentRun(agent, d.payload.commandId as string, { state: 'done', result: { ci: CI({ state: 'pending', checks: [{ name: 'build', bucket: 'pending', link: null }], run: null }) } });
      // oyna ichida (idempotency kaliti bir xil) yana yaratilmaydi: bir xil buyruq qaytadi, yangi dispatch yo'q
      await svc(GitOpsService).pollCi(now);
      await agent.expectNone('command.dispatch', 300);
      const audit = await ds.query(`SELECT actor_kind FROM audit_log WHERE action = 'command.created' AND target = $1`, [d.payload.commandId]);
      expect(audit[0].actor_kind).toBe('system');
    });
  });
});

const DiffResponseCheck = (b: unknown) => DiffResponseSchema.parse(b);
