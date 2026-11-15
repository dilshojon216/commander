import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SessionDtoSchema } from '@commander/contracts';
import type { CommandDto, SessionDto } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
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
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/** 6.14 session.resume / session.close — haqiqiy TimescaleDB; agentd o'rniga soxta sender. */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let hw = 0;
const dispatched: Array<{ machineId: string; type: string; payload: { commandId: string; type: string; payload: Record<string, unknown> } }> = [];

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, remoteControl: true, resume: true, close: true };

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule,
    ],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS).useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS).useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: Object.fromEntries(Object.entries(DEFAULT_COMMANDS_OPTIONS.rateLimits).map(([k]) => [k, [1000, 60_000]])) })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newMachine(name: string, opts: { control?: Record<string, unknown> | null } = {}): Promise<{ machineId: string; deviceId: string }> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: publicKey.export({ format: 'jwk' }).x as string, hardware_id: `hw-t-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'darwin', arch: 'arm64' })
    .expect(201);
  const machineId = res.body.machine_id as string;
  const deviceId = res.body.device_id as string;
  await ds.query(`UPDATE machines SET online = true, control = $2::jsonb WHERE id = $1`, [machineId, JSON.stringify(opts.control === undefined ? CONTROL_ON : opts.control)]);
  svc(AgentDispatchService).register(machineId, {
    deviceId,
    send: (type, payload) => {
      dispatched.push({ machineId, type, payload: payload as never });
      return true;
    },
  });
  return { machineId, deviceId };
}

async function issueToken(scopes: string[], kind: 'web' | 'telegram' = 'web'): Promise<{ id: string; token: string }> {
  const t = await svc(ClientTokensService).issue({ kind, name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return { id: t.id, token: t.token };
}
async function exemptToken(): Promise<{ id: string; token: string }> {
  const t = await issueToken(['read', 'control']);
  await ds.query(
    `INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = settings.value || $1::jsonb`,
    [JSON.stringify([t.id])],
  );
  return t;
}
async function newProject(machineId: string, name: string, over: { repoKey?: string; branch?: string; tasks?: Array<[string, string]> } = {}): Promise<string> {
  const [p] = (await ds.query(`INSERT INTO projects (machine_id, path, name, repo_key, kind) VALUES ($1, $2, $3, $4, 'git') RETURNING id`, [machineId, `/zz/${name}`, name, over.repoKey ?? null])) as Array<{ id: string }>;
  if (over.branch) await ds.query(`INSERT INTO project_snapshots (project_id, hash, branch) VALUES ($1, $2, $3)`, [p!.id, randomBytes(8).toString('hex'), over.branch]);
  for (const [i, [key, title]] of (over.tasks ?? []).entries()) await ds.query(`INSERT INTO project_tasks (project_id, task_key, title, status, "order") VALUES ($1, $2, $3, 'todo', $4)`, [p!.id, key, title, i]);
  return p!.id;
}
async function newSession(machineId: string, kind: 'bg' | 'tmux' | 'interactive', over: { projectId?: string; cwd?: string } = {}): Promise<{ id: string; claudeSessionId: string }> {
  const claudeSessionId = `s-${randomBytes(4).toString('hex')}`;
  const [r] = (await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, kind, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, $4, 'p', $5, 'idle', now(), now(), now()) RETURNING id`,
    [machineId, claudeSessionId, over.projectId ?? null, over.cwd ?? '/zz/proj', kind],
  )) as Array<{ id: string }>;
  return { id: r!.id, claudeSessionId };
}
const actions = async (target: string): Promise<string[]> => (await ds.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY id`, [target])).map((r: { action: string }) => r.action);
const lastDispatch = (machineId: string) => dispatched.filter((d) => d.machineId === machineId && d.type === 'command.dispatch').at(-1);


async function endSession(id: string): Promise<void> {
  await ds.query(`UPDATE sessions SET status = 'ended', ended_at = now() - interval '1 minute', end_reason = 'exit' WHERE id = $1`, [id]);
}
const post = (token: string, body: Record<string, unknown>) => http().post('/v1/commands').set(bearer(token)).send(body);
const getSession = async (token: string, id: string) => SessionDtoSchema.parse((await http().get(`/v1/sessions/${id}`).set(bearer(token)).expect(200)).body) as SessionDto;

describe('6.14 session.resume', () => {
  it('tugagan terminal sessiya: SessionDto.resume.available, step-up (istisnosiz), dispatch payload cwd markazdan, natija sessiyani tmux ga o\'tkazadi', async () => {
    const m = await newMachine('zz-rs1');
    const plain = await issueToken(['read', 'control']);
    const s = await newSession(m.machineId, 'interactive', { cwd: '/zz/resume-proj' });
    // tirik: tugma yo'q, buyruq session_still_running bilan rad
    expect((await getSession(plain.token, s.id)).resume).toEqual({ available: false, reason: 'not_ended' });
    const rej = (await post(plain.token, { type: 'session.resume', sessionId: s.id }).expect(201)).body.command as CommandDto;
    expect(rej).toMatchObject({ status: 'rejected', errorCode: 'session_still_running' });
    expect(dispatchedFor(m.machineId)).toHaveLength(0);

    await endSession(s.id);
    expect((await getSession(plain.token, s.id)).resume).toEqual({ available: true, reason: null });
    // mijoz cwd/claudeSessionId berolmaydi (strict)
    await post(plain.token, { type: 'session.resume', sessionId: s.id, cwd: '/etc' }).expect(400);
    // step-up: istisnosiz qurilma -> awaiting_confirmation, dispatch yo'q
    const waiting = (await post(plain.token, { type: 'session.resume', sessionId: s.id }).expect(201)).body.command as CommandDto;
    expect(waiting.stepUp.required).toBe(true);
    expect(['awaiting_confirmation', 'failed']).toContain(waiting.status);
    expect(dispatchedFor(m.machineId)).toHaveLength(0);
  });

  it('istisno qurilma: dispatch (imzolangan, cwd markaz DB\'sidan), audit, natija: kind=tmux, ended_at tozalanadi, tmuxSession natijada', async () => {
    const m = await newMachine('zz-rs2');
    const ex = await exemptToken();
    const s = await newSession(m.machineId, 'interactive', { cwd: '/zz/resume-proj' });
    await endSession(s.id);
    const cmd = (await post(ex.token, { type: 'session.resume', sessionId: s.id }).expect(201)).body.command as CommandDto;
    expect(cmd).toMatchObject({ type: 'session.resume', status: 'sent', sessionId: s.id });
    const d = lastDispatch(m.machineId)!;
    expect(d.payload).toMatchObject({ type: 'session.resume', payload: { claudeSessionId: s.claudeSessionId, cwd: '/zz/resume-proj' } });
    expect(d.payload).toHaveProperty('sig');
    // bir vaqtda ikkinchi resume: command_in_flight
    await post(ex.token, { type: 'session.resume', sessionId: s.id }).expect(409);

    await svc(CommandsService).handleAck(m.machineId, { commandId: cmd.id });
    await svc(CommandsService).handleResult(m.machineId, { commandId: cmd.id, state: 'done', result: { claudeSessionId: s.claudeSessionId, tmuxSession: 'cmdr-abcd1234', detail: 'tmux attach -t cmdr-abcd1234' } });
    const dto = await getSession(ex.token, s.id);
    expect(dto).toMatchObject({ kind: 'tmux', endedAt: null, controllable: true, controls: { prompt: true, stop: true, close: true } });
    expect(dto.resume).toEqual({ available: false, reason: 'not_ended' });
    const done = (await http().get(`/v1/commands/${cmd.id}`).set(bearer(ex.token)).expect(200)).body as CommandDto;
    expect(done.result?.tmuxSession).toBe('cmdr-abcd1234');
    expect(await actions(cmd.id)).toEqual(expect.arrayContaining(['command.created', 'command.dispatched', 'command.result']));
    const created = (await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [cmd.id]))[0];
    expect(created.details).toMatchObject({ type: 'session.resume', claude_session_id: s.claudeSessionId });
  });

  it('natijadagi claudeSessionId boshqa (nusxa): sessiya qatori O\'ZGARMAYDI; agent xatosi (resume_forked) saqlanadi', async () => {
    const m = await newMachine('zz-rs3');
    const ex = await exemptToken();
    const s = await newSession(m.machineId, 'interactive');
    await endSession(s.id);
    const cmd = (await post(ex.token, { type: 'session.resume', sessionId: s.id }).expect(201)).body.command as CommandDto;
    await svc(CommandsService).handleAck(m.machineId, { commandId: cmd.id });
    await svc(CommandsService).handleResult(m.machineId, { commandId: cmd.id, state: 'failed', error: { code: 'resume_forked', message: 'copy' } });
    const dto = await getSession(ex.token, s.id);
    expect(dto).toMatchObject({ kind: 'interactive', status: 'ended' });
    expect(dto.endedAt).not.toBeNull();
    expect(((await http().get(`/v1/commands/${cmd.id}`).set(bearer(ex.token)).expect(200)).body as CommandDto).errorCode).toBe('resume_forked');
  });

  it('rad etishlar: Windows (resume_unsupported), eski agentd (agent_outdated), allowStart yo\'q, bg sessiya, offline, lockdown', async () => {
    const ex = await exemptToken();
    const win = await newMachine('zz-rs4');
    await ds.query(`UPDATE machines SET os = 'win32' WHERE id = $1`, [win.machineId]);
    const sw = await newSession(win.machineId, 'interactive');
    await endSession(sw.id);
    expect(((await post(ex.token, { type: 'session.resume', sessionId: sw.id }).expect(201)).body.command as CommandDto).errorCode).toBe('resume_unsupported');

    const old = await newMachine('zz-rs5', { control: { ...CONTROL_ON, resume: undefined } });
    const so = await newSession(old.machineId, 'interactive');
    await endSession(so.id);
    expect(((await post(ex.token, { type: 'session.resume', sessionId: so.id }).expect(201)).body.command as CommandDto).errorCode).toBe('agent_outdated');

    const nostart = await newMachine('zz-rs6', { control: { ...CONTROL_ON, allowStart: false } });
    const sn = await newSession(nostart.machineId, 'tmux');
    await endSession(sn.id);
    expect(((await post(ex.token, { type: 'session.resume', sessionId: sn.id }).expect(201)).body.command as CommandDto).errorCode).toBe('action_not_allowed');

    const ok = await newMachine('zz-rs7');
    const sb = await newSession(ok.machineId, 'bg');
    await endSession(sb.id);
    expect(((await post(ex.token, { type: 'session.resume', sessionId: sb.id }).expect(201)).body.command as CommandDto).errorCode).toBe('interactive_session');

    const sx = await newSession(ok.machineId, 'interactive');
    await endSession(sx.id);
    await ds.query(`UPDATE machines SET online = false WHERE id = $1`, [ok.machineId]);
    expect(((await post(ex.token, { type: 'session.resume', sessionId: sx.id }).expect(201)).body.command as CommandDto).errorCode).toBe('machine_offline');
    await ds.query(`UPDATE machines SET online = true WHERE id = $1`, [ok.machineId]);

    await svc(LockdownService).set(true, 'test');
    try {
      await post(ex.token, { type: 'session.resume', sessionId: sx.id }).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });

  it('read scope resume/close yarata olmaydi (403); tokensiz 401', async () => {
    const reader = await issueToken(['read']);
    const sid = randomUUID();
    await http().post('/v1/commands').send({ type: 'session.resume', sessionId: sid }).expect(401);
    await post(reader.token, { type: 'session.resume', sessionId: sid }).expect(403);
    await post(reader.token, { type: 'session.close', sessionId: sid }).expect(403);
  });
});

describe('6.14 session.close', () => {
  it('tmux sessiya: dispatch (step-up yo\'q), natija done; interaktiv (tmuxsiz) va bg: interactive_session; allowStop yo\'q: action_not_allowed', async () => {
    const m = await newMachine('zz-cl1');
    const plain = await issueToken(['read', 'control']);
    const s = await newSession(m.machineId, 'tmux');
    const cmd = (await post(plain.token, { type: 'session.close', sessionId: s.id }).expect(201)).body.command as CommandDto;
    expect(cmd).toMatchObject({ type: 'session.close', status: 'sent', stepUp: { required: false } });
    expect(lastDispatch(m.machineId)!.payload).toMatchObject({ type: 'session.close', payload: { claudeSessionId: s.claudeSessionId } });
    await svc(CommandsService).handleAck(m.machineId, { commandId: cmd.id });
    await svc(CommandsService).handleResult(m.machineId, { commandId: cmd.id, state: 'done', result: { claudeSessionId: s.claudeSessionId, detail: 'exited gracefully (/exit)' } });
    expect(((await http().get(`/v1/commands/${cmd.id}`).set(bearer(plain.token)).expect(200)).body as CommandDto).status).toBe('done');
    // sessiya qatori SessionEnd hook'idan tugaydi: close natijasi uni o'zi tugatmaydi (halol hisobot)
    expect((await getSession(plain.token, s.id)).endedAt).toBeNull();

    const si = await newSession(m.machineId, 'interactive');
    expect(((await post(plain.token, { type: 'session.close', sessionId: si.id }).expect(201)).body.command as CommandDto).errorCode).toBe('interactive_session');
    const sb = await newSession(m.machineId, 'bg');
    expect(((await post(plain.token, { type: 'session.close', sessionId: sb.id }).expect(201)).body.command as CommandDto).errorCode).toBe('interactive_session');

    const stopless = await newMachine('zz-cl2', { control: { ...CONTROL_ON, allowStop: false } });
    const st = await newSession(stopless.machineId, 'tmux');
    expect(((await post(plain.token, { type: 'session.close', sessionId: st.id }).expect(201)).body.command as CommandDto).errorCode).toBe('action_not_allowed');
    const old = await newMachine('zz-cl3', { control: { ...CONTROL_ON, close: undefined } });
    const so = await newSession(old.machineId, 'tmux');
    expect(((await post(plain.token, { type: 'session.close', sessionId: so.id }).expect(201)).body.command as CommandDto).errorCode).toBe('agent_outdated');
  });
  it('lockdown yopishni bloklaydi (403)', async () => {
    const m = await newMachine('zz-cl4');
    const plain = await issueToken(['read', 'control']);
    const s = await newSession(m.machineId, 'tmux');
    await svc(LockdownService).set(true, 'test');
    try {
      await post(plain.token, { type: 'session.close', sessionId: s.id }).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });
});

const dispatchedFor = (machineId: string) => dispatched.filter((d) => d.machineId === machineId && d.type === 'command.dispatch');
