import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SessionDtoSchema, TemplateDtoSchema, RenderTemplateResponseSchema } from '@commander/contracts';
import type { CommandDto, SessionDto, TemplateDto } from '@commander/contracts';
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
import { TemplatesModule } from '../../src/templates/templates.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/** 3.4 (prompt shablonlari) va 3.10 (Remote Control) — haqiqiy TimescaleDB; agentd o'rniga soxta sender. */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let hw = 0;
const dispatched: Array<{ machineId: string; type: string; payload: { commandId: string; type: string; payload: Record<string, unknown> } }> = [];

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, remoteControl: true };
const URL1 = 'https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y';

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, TemplatesModule,
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

// --- 3.4 ----------------------------------------------------------------------------------------------------------

describe('3.4 shablonlar: seed va CRUD', () => {
  it('seed: 5 ta global shablon (o\'zbekcha nomlar), to\'g\'ri o\'zgaruvchilar bilan', async () => {
    const t = await issueToken(['read']);
    const res = await http().get('/v1/templates').set(bearer(t.token)).expect(200);
    const items = (res.body.items as unknown[]).map((i) => TemplateDtoSchema.parse(i)) as TemplateDto[];
    const names = items.filter((i) => i.builtin).map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['Testlarni yurgiz va tuzat', 'Kod review', 'CHANGELOG yangila', 'Deploy oldidan tekshiruv', 'TASKS.md holatini yangila']));
    expect(items.every((i) => i.scope === 'global' || !i.builtin)).toBe(true);
    expect(items.find((i) => i.name === 'TASKS.md holatini yangila')?.variables).toEqual(['project', 'task_key', 'task_title']);
  });

  it('yozish control scope talab qiladi; read 403; tokensiz 401; yaroqsiz tana 400 (noma\'lum o\'zgaruvchi, ko\'lam)', async () => {
    const reader = await issueToken(['read']);
    const writer = await issueToken(['read', 'control']);
    const body = { scope: 'global', name: `t-${randomBytes(3).toString('hex')}`, body: 'Salom {{project}}' };
    await http().post('/v1/templates').send(body).expect(401);
    await http().post('/v1/templates').set(bearer(reader.token)).send(body).expect(403);
    await http().post('/v1/templates').set(bearer(writer.token)).send({ ...body, body: 'x {{secret}}' }).expect(400);
    await http().post('/v1/templates').set(bearer(writer.token)).send({ ...body, scope: 'project' }).expect(400);
    await http().post('/v1/templates').set(bearer(writer.token)).send({ ...body, permissionMode: 'bypassPermissions' }).expect(400);
  });

  it('yaratish/tahrirlash/o\'chirish: audit, 409 nom takrori, sir (token) rad', async () => {
    const w = await issueToken(['read', 'control']);
    const name = `crud-${randomBytes(3).toString('hex')}`;
    const created = TemplateDtoSchema.parse((await http().post('/v1/templates').set(bearer(w.token)).send({ scope: 'global', name, body: 'A {{date}}', description: 'tavsif', model: 'haiku', permissionMode: 'plan' }).expect(201)).body);
    expect(created).toMatchObject({ name, builtin: false, createdByDeviceId: w.id, variables: ['date'], model: 'haiku', permissionMode: 'plan' });
    await http().post('/v1/templates').set(bearer(w.token)).send({ scope: 'global', name: name.toUpperCase(), body: 'x' }).expect(409);
    const upd = TemplateDtoSchema.parse((await http().patch(`/v1/templates/${created.id}`).set(bearer(w.token)).send({ body: 'B {{branch}}', model: null }).expect(200)).body);
    expect(upd).toMatchObject({ body: 'B {{branch}}', model: null, variables: ['branch'] });
    expect((await http().post('/v1/templates').set(bearer(w.token)).send({ scope: 'global', name: `s-${name}`, body: 'token=abcdef0123456789' }).expect(422)).body.error).toBe('secret_detected');
    expect((await http().patch(`/v1/templates/${created.id}`).set(bearer(w.token)).send({ body: 'sk-ant-abcdefghijklmnop' }).expect(422)).body.error).toBe('secret_detected');
    await http().delete(`/v1/templates/${created.id}`).set(bearer(w.token)).expect(200);
    await http().get(`/v1/templates/${created.id}`).set(bearer(w.token)).expect(404);
    expect(await actions(created.id)).toEqual(expect.arrayContaining(['template.created', 'template.update', 'template.updated', 'template.delete', 'template.deleted']));
  });

  it('lockdown: yozish 403 (guard), o\'qish ishlaydi', async () => {
    const w = await issueToken(['read', 'control']);
    await svc(LockdownService).set(true, 'test');
    try {
      await http().post('/v1/templates').set(bearer(w.token)).send({ scope: 'global', name: `lk-${randomBytes(3).toString('hex')}`, body: 'x' }).expect(403);
      await http().get('/v1/templates').set(bearer(w.token)).expect(200);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });

  it('ko\'lam ko\'rinishi: ?projectId = global + shu loyiha + shu repo; boshqa loyiha/repo ko\'rinmaydi', async () => {
    const m = await newMachine('zz-t-scope');
    const w = await issueToken(['read', 'control']);
    const repo = `github.com/zz/${randomBytes(3).toString('hex')}`;
    const p1 = await newProject(m.machineId, `p1-${randomBytes(2).toString('hex')}`, { repoKey: repo });
    const p2 = await newProject(m.machineId, `p2-${randomBytes(2).toString('hex')}`, { repoKey: `${repo}-other` });
    const mk = async (b: Record<string, unknown>) => TemplateDtoSchema.parse((await http().post('/v1/templates').set(bearer(w.token)).send({ body: 'x', ...b }).expect(201)).body);
    const suf = randomBytes(2).toString('hex');
    const g = await mk({ scope: 'global', name: `g-${suf}` });
    const a = await mk({ scope: 'project', projectId: p1, name: `a-${suf}` });
    const b = await mk({ scope: 'project', projectId: p2, name: `b-${suf}` });
    const r1 = await mk({ scope: 'repo', repoKey: repo, name: `r1-${suf}` });
    const r2 = await mk({ scope: 'repo', repoKey: `${repo}-other`, name: `r2-${suf}` });
    expect(a.projectName).toContain('p1-');
    const ids = (await http().get(`/v1/templates?projectId=${p1}`).set(bearer(w.token)).expect(200)).body.items.map((i: { id: string }) => i.id) as string[];
    expect(ids).toEqual(expect.arrayContaining([g.id, a.id, r1.id]));
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(r2.id);
    await http().post('/v1/templates').set(bearer(w.token)).send({ scope: 'project', projectId: randomUUID(), name: `x-${suf}`, body: 'x' }).expect(404);
    // loyiha o'chsa shablon ham (CASCADE)
    await ds.query(`DELETE FROM projects WHERE id = $1`, [p2]);
    await http().get(`/v1/templates/${b.id}`).set(bearer(w.token)).expect(404);
  });
});

describe('3.4 render va sessiyaga yuborish', () => {
  async function tpl(token: string, body: string, over: Record<string, unknown> = {}): Promise<TemplateDto> {
    return TemplateDtoSchema.parse((await http().post('/v1/templates').set(bearer(token)).send({ scope: 'global', name: `r-${randomBytes(4).toString('hex')}`, body, ...over }).expect(201)).body);
  }

  it('render: loyiha, branch, vazifa sarlavhasi, sana; hech narsa saqlanmaydi (audit/DB)', async () => {
    const m = await newMachine('zz-t-render');
    const w = await issueToken(['read', 'control']);
    const reader = await issueToken(['read']);
    const projectId = await newProject(m.machineId, 'commander-zz', { branch: 'feat/x', tasks: [['3.4', 'Tayyor buyruqlar']] });
    const t = await tpl(w.token, 'Loyiha {{project}} / {{branch}} / {{task_key}}: {{task_title}} / {{date}} {{ project }}');
    const before = (await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE target = $1 OR action LIKE 'template.%'`, [t.id]))[0].n as number;
    const maxId = (await ds.query(`SELECT COALESCE(max(id), 0)::text AS id FROM audit_log`))[0].id as string;
    const r = RenderTemplateResponseSchema.parse((await http().post(`/v1/templates/${t.id}/render`).set(bearer(reader.token)).send({ projectId, taskKey: '3.4' }).expect(200)).body);
    expect(r.text).toMatch(/^Loyiha commander-zz \/ feat\/x \/ 3\.4: Tayyor buyruqlar \/ \d{4}-\d{2}-\d{2} commander-zz$/);
    expect(r.missing).toEqual([]);
    expect(r.tooLong).toBe(false);
    // render auditga yozilmaydi (o'qish) va matn hech qayerda saqlanmaydi
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE target = $1 OR action LIKE 'template.%'`, [t.id]))[0].n).toBe(before);
    expect((await ds.query(`SELECT action FROM audit_log WHERE id > $1::bigint`, [maxId])).map((r: { action: string }) => r.action).filter((a: string) => a.startsWith('template.') || a.includes('render'))).toEqual([]);
    const dump = JSON.stringify(await ds.query(`SELECT to_jsonb(t)::text AS j FROM prompt_templates t WHERE id = $1`, [t.id]));
    expect(dump).not.toContain('commander-zz');
  });

  it('render: yetishmayotgan o\'zgaruvchilar missing; noma\'lum loyiha/sessiya 404; yaroqsiz tana 400', async () => {
    const w = await issueToken(['read', 'control']);
    const t = await tpl(w.token, '{{task_key}} {{branch}} {{project}}');
    const r = RenderTemplateResponseSchema.parse((await http().post(`/v1/templates/${t.id}/render`).set(bearer(w.token)).send({}).expect(200)).body);
    expect(r.missing).toEqual(['task_key', 'branch', 'project']);
    expect(r.text).toBe('{{task_key}} {{branch}} {{project}}');
    await http().post(`/v1/templates/${t.id}/render`).set(bearer(w.token)).send({ projectId: randomUUID() }).expect(404);
    await http().post(`/v1/templates/${t.id}/render`).set(bearer(w.token)).send({ sessionId: randomUUID() }).expect(404);
    await http().post(`/v1/templates/${t.id}/render`).set(bearer(w.token)).send({ extra: 1 }).expect(400);
    await http().post(`/v1/templates/${randomUUID()}/render`).set(bearer(w.token)).send({}).expect(404);
  });

  it('send-prompt: session.prompt buyrug\'i yaratiladi (policy/audit o\'sha yo\'lda); render matni agentga boradi, DB\'da redakt', async () => {
    const m = await newMachine('zz-t-send');
    const w = await issueToken(['read', 'control']);
    const projectId = await newProject(m.machineId, 'send-proj', { branch: 'main', tasks: [['9.9', 'Vazifa token=abcdef0123456789']] });
    const s = await newSession(m.machineId, 'bg', { projectId });
    await ds.query(`INSERT INTO session_task_spans (machine_id, session_id, project_id, task_key, source, started_at) VALUES ($1, $2, $3, '9.9', 'explicit', now())`, [m.machineId, s.claudeSessionId, projectId]);
    const t = await tpl(w.token, 'Yangila {{task_key}} ({{task_title}}) {{project}}@{{branch}}');
    const res = await http().post(`/v1/templates/${t.id}/send-prompt`).set(bearer(w.token)).send({ sessionId: s.id }).expect(201);
    const cmd = res.body.command as CommandDto;
    expect(cmd).toMatchObject({ type: 'session.prompt', sessionId: s.id });
    const sent = lastDispatch(m.machineId)!;
    expect(sent.payload.payload).toMatchObject({ claudeSessionId: s.claudeSessionId });
    expect(String(sent.payload.payload.text)).toContain('Yangila 9.9 (Vazifa token=abcdef0123456789) send-proj@main');
    const stored = (await ds.query(`SELECT payload::text AS p FROM commands WHERE id = $1`, [cmd.id]))[0].p as string;
    expect(stored).not.toContain('abcdef0123456789');
    expect(await actions(t.id)).toContain('template.sent');
    expect(await actions(cmd.id)).toContain('command.created');
  });

  it('send-prompt: yetishmayotgan o\'zgaruvchi 422 (yarim matn yuborilmaydi), read scope 403, noma\'lum sessiya 404, lockdown 403', async () => {
    const m = await newMachine('zz-t-send2');
    const w = await issueToken(['read', 'control']);
    const reader = await issueToken(['read']);
    const s = await newSession(m.machineId, 'bg');
    const t = await tpl(w.token, 'Ish {{task_key}}');
    const before = dispatched.length;
    const r = await http().post(`/v1/templates/${t.id}/send-prompt`).set(bearer(w.token)).send({ sessionId: s.id }).expect(422);
    expect(r.body).toMatchObject({ error: 'missing_variables', missing: ['task_key'] });
    expect(dispatched.length).toBe(before);
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE session_id = $1`, [s.id]))[0].n).toBe(0);
    await http().post(`/v1/templates/${t.id}/send-prompt`).set(bearer(reader.token)).send({ sessionId: s.id, taskKey: '1.1' }).expect(403);
    await http().post(`/v1/templates/${t.id}/send-prompt`).set(bearer(w.token)).send({ sessionId: randomUUID(), taskKey: '1.1' }).expect(404);
    await svc(LockdownService).set(true, 'test');
    try {
      await http().post(`/v1/templates/${t.id}/send-prompt`).set(bearer(w.token)).send({ sessionId: s.id, taskKey: '1.1' }).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });
});

// --- 3.10 ---------------------------------------------------------------------------------------------------------

describe('3.10 Remote Control', () => {
  const rc = (token: string, sessionId: string, enable: boolean, name?: string, key?: string) =>
    http().post('/v1/commands').set(bearer(token)).set(key ? { 'Idempotency-Key': key } : {}).send({ type: 'session.remote_control', sessionId, enable, ...(name ? { name } : {}) });

  it('tmux sessiya: istisno qurilma yoqadi -> imzolangan dispatch; natija sessions.remote_control + SessionDto + audit', async () => {
    const m = await newMachine('zz-rc1');
    const ex = await exemptToken();
    const s = await newSession(m.machineId, 'tmux');
    const res = await rc(ex.token, s.id, true, 'my rc').expect(201);
    const cmd = res.body.command as CommandDto;
    expect(cmd).toMatchObject({ type: 'session.remote_control', status: 'sent', stepUp: { required: false } });
    const d = lastDispatch(m.machineId)!;
    expect(d.payload).toMatchObject({ type: 'session.remote_control', payload: { claudeSessionId: s.claudeSessionId, enable: true, name: 'my rc' } });
    expect(d.payload).toHaveProperty('sig');

    await svc(CommandsService).handleAck(m.machineId, { commandId: cmd.id });
    await svc(CommandsService).handleResult(m.machineId, { commandId: cmd.id, state: 'done', result: { claudeSessionId: s.claudeSessionId, detail: 'enabled', remoteControl: { enabled: true, name: 'my rc', url: URL1 } } });
    const dto = SessionDtoSchema.parse((await http().get(`/v1/sessions/${s.id}`).set(bearer(ex.token)).expect(200)).body) as SessionDto;
    expect(dto.remoteControl).toMatchObject({ enabled: true, name: 'my rc', url: URL1 });
    expect(dto.controls.remoteControl).toBe(true);
    const created = (await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [cmd.id]))[0];
    expect(created.details).toMatchObject({ type: 'session.remote_control', enable: true, step_up: false });

    // takroriy yoqish (agent "already enabled": nomsiz natija) oldingi nomni saqlaydi
    const again = (await rc(ex.token, s.id, true).expect(201)).body.command as CommandDto;
    await svc(CommandsService).handleResult(m.machineId, { commandId: again.id, state: 'done', result: { remoteControl: { enabled: true, url: URL1 } } });
    expect(SessionDtoSchema.parse((await http().get(`/v1/sessions/${s.id}`).set(bearer(ex.token)).expect(200)).body).remoteControl).toMatchObject({ enabled: true, name: 'my rc', url: URL1 });
    // o'chirish: step-up yo'q (istisnodan qat'i nazar)
    const off = (await rc(ex.token, s.id, false).expect(201)).body.command as CommandDto;
    await svc(CommandsService).handleResult(m.machineId, { commandId: off.id, state: 'done', result: { remoteControl: { enabled: false } } });
    const dto2 = SessionDtoSchema.parse((await http().get(`/v1/sessions/${s.id}`).set(bearer(ex.token)).expect(200)).body);
    expect(dto2.remoteControl).toMatchObject({ enabled: false, name: null });
  });

  it('istisnosiz qurilma yoqishda step-up talab qiladi (kanal yo\'q = failed(step_up_unavailable), dispatch yo\'q); o\'chirish tasdiqsiz', async () => {
    const m = await newMachine('zz-rc2');
    const plain = await issueToken(['read', 'control']);
    const s = await newSession(m.machineId, 'tmux');
    const before = dispatched.length;
    const c = (await rc(plain.token, s.id, true).expect(201)).body.command as CommandDto;
    expect(c).toMatchObject({ status: 'failed', errorCode: 'step_up_unavailable', stepUp: { required: true } });
    expect(dispatched.length).toBe(before);
    const off = (await rc(plain.token, s.id, false).expect(201)).body.command as CommandDto;
    expect(off).toMatchObject({ status: 'sent', stepUp: { required: false } });
  });

  it('step-up kanali bor: awaiting_confirmation -> boshqa qurilma tasdiqlaydi -> dispatch', async () => {
    const m = await newMachine('zz-rc3');
    const plain = await issueToken(['read', 'control']);
    const confirmer = await issueToken(['read', 'approve'], 'telegram');
    const s = await newSession(m.machineId, 'tmux');
    const unregister = svc(StepUpRegistry).register({ isAvailable: async () => true, request: async () => 1 });
    try {
      const c = (await rc(plain.token, s.id, true).expect(201)).body.command as CommandDto;
      expect(c).toMatchObject({ status: 'awaiting_confirmation', stepUp: { required: true } });
      const before = dispatched.length;
      const out = await svc(CommandsService).confirm(c.id, { deviceId: confirmer.id, actorKind: 'telegram', ip: null });
      expect(out.outcome).toBe('confirmed');
      expect(dispatched.length - before).toBe(1);
      expect(out.command.status).toBe('sent');
    } finally {
      unregister();
    }
  });

  it('Telegram inline tasdiq yoqishni ikkinchi so\'rovsiz o\'tkazadi; boshqa aktor uchun e\'tiborsiz; audit command.confirmed', async () => {
    const m = await newMachine('zz-rc4');
    const tg = await issueToken(['read', 'control'], 'telegram');
    const web = await issueToken(['read', 'control']);
    const s = await newSession(m.machineId, 'tmux');
    const cs = svc(CommandsService);
    const ok = await cs.create({ type: 'session.remote_control', sessionId: s.id, enable: true }, { deviceId: tg.id, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' }, `tg-rc-${randomBytes(4).toString('hex')}`);
    expect(ok.command).toMatchObject({ status: 'sent', stepUp: { required: false, confirmedByDeviceId: tg.id } });
    await cs.handleResult(m.machineId, { commandId: ok.command.id, state: 'done', result: { remoteControl: { enabled: true, url: URL1 } } });
    expect(await actions(ok.command.id)).toEqual(expect.arrayContaining(['command.created', 'command.confirmed', 'command.dispatched']));
    // nom berilmagan: doimiy default nom (claude.ai/code'da topish uchun)
    expect(lastDispatch(m.machineId)!.payload.payload).toMatchObject({ enable: true, name: `cmdr-${s.claudeSessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}` });
    // `web` aktori inline bayrog'ini qo'ysa ham ishlamaydi (kanal yo'q = step-up kerak)
    const bad = await cs.create({ type: 'session.remote_control', sessionId: s.id, enable: true }, { deviceId: web.id, actorKind: 'web', ip: null, confirmation: 'telegram_inline' }, `web-rc-${randomBytes(4).toString('hex')}`);
    expect(bad.command).toMatchObject({ status: 'failed', errorCode: 'step_up_unavailable' });
  });

  it('rad etishlar: bg sessiya (remote_control_unsupported), tmuxsiz terminal, allowPrompt=false, eski agentd, tugagan sessiya', async () => {
    const ex = await exemptToken();
    const m = await newMachine('zz-rc5');
    const bg = await newSession(m.machineId, 'bg');
    const term = await newSession(m.machineId, 'interactive');
    expect((await rc(ex.token, bg.id, true).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'remote_control_unsupported' });
    expect((await rc(ex.token, term.id, true).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'interactive_session' });

    const np = await newMachine('zz-rc5b', { control: { ...CONTROL_ON, allowPrompt: false } });
    const s1 = await newSession(np.machineId, 'tmux');
    expect((await rc(ex.token, s1.id, true).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'action_not_allowed' });

    const old = await newMachine('zz-rc5c', { control: { ...CONTROL_ON, remoteControl: undefined } });
    const s2 = await newSession(old.machineId, 'tmux');
    expect((await rc(ex.token, s2.id, true).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'agent_outdated' });
    expect(dispatched.filter((d) => d.machineId === np.machineId || d.machineId === old.machineId)).toHaveLength(0);

    const s3 = await newSession(m.machineId, 'tmux');
    await ds.query(`UPDATE sessions SET ended_at = now(), status = 'ended' WHERE id = $1`, [s3.id]);
    expect((await rc(ex.token, s3.id, true).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'session_ended' });
  });

  it('lockdown: yoqish/o\'chirish 403 (guard)', async () => {
    const m = await newMachine('zz-rc6');
    const ex = await exemptToken();
    const s = await newSession(m.machineId, 'tmux');
    await svc(LockdownService).set(true, 'test');
    try {
      await rc(ex.token, s.id, true).expect(403);
      await rc(ex.token, s.id, false).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
  });

  it('session.start + remoteControl: istisno qurilmada dispatch payload\'da remoteControl; istisnosizda step-up; natija sessiyaga yoziladi', async () => {
    const m = await newMachine('zz-rc7');
    const ex = await exemptToken();
    const plain = await issueToken(['read', 'control']);
    const start = { type: 'session.start', machineId: m.machineId, cwd: '/zz/proj', prompt: 'hello', permissionMode: 'plan', name: 'nightly', remoteControl: true };
    const c = (await http().post('/v1/commands').set(bearer(ex.token)).send(start).expect(201)).body.command as CommandDto;
    expect(c.status).toBe('sent');
    expect(lastDispatch(m.machineId)!.payload.payload).toMatchObject({ cwd: '/zz/proj', name: 'nightly', remoteControl: true });
    const csid = `rcs-${randomBytes(3).toString('hex')}`;
    await svc(CommandsService).handleResult(m.machineId, { commandId: c.id, state: 'done', result: { claudeSessionId: csid, remoteControl: { enabled: true, name: 'nightly', url: URL1 } } });
    const row = (await ds.query(`SELECT remote_control FROM sessions WHERE machine_id = $1 AND claude_session_id = $2`, [m.machineId, csid]))[0];
    expect(row.remote_control).toMatchObject({ enabled: true, name: 'nightly', url: URL1 });
    const cs = (await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [c.id]))[0];
    expect(cs.details).toMatchObject({ remote_control: true });

    const p = (await http().post('/v1/commands').set(bearer(plain.token)).send(start).expect(201)).body.command as CommandDto;
    expect(p).toMatchObject({ status: 'failed', errorCode: 'step_up_unavailable' });
    // allowPrompt=false mashinada RC bilan ochish rad, RC'siz ochish o'tadi
    const np = await newMachine('zz-rc7b', { control: { ...CONTROL_ON, allowPrompt: false } });
    expect((await http().post('/v1/commands').set(bearer(ex.token)).send({ ...start, machineId: np.machineId }).expect(201)).body.command).toMatchObject({ status: 'rejected', errorCode: 'action_not_allowed' });
    const { remoteControl: _omit, ...plainStart } = start;
    expect((await http().post('/v1/commands').set(bearer(ex.token)).send({ ...plainStart, machineId: np.machineId }).expect(201)).body.command.status).toBe('sent');
  });

  it('noto\'g\'ri nom / tana: 400', async () => {
    const m = await newMachine('zz-rc8');
    const ex = await exemptToken();
    const s = await newSession(m.machineId, 'tmux');
    await rc(ex.token, s.id, true, 'x; rm -rf /').expect(400);
    await http().post('/v1/commands').set(bearer(ex.token)).send({ type: 'session.remote_control', sessionId: s.id }).expect(400);
  });
});
