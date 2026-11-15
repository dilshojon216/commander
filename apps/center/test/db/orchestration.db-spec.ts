import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MailboxCallSchema, OrchestrationDtoSchema, ORCH_LIMITS } from '@commander/contracts';
import type { MailboxCall, OrchestrationDto } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { MessagingModule } from '../../src/messaging/messaging.module.js';
import { MessagingService } from '../../src/messaging/messaging.service.js';
import { OrchestrationModule } from '../../src/orchestration/orchestration.module.js';
import { ORCH_OPTIONS } from '../../src/orchestration/orchestration.options.js';
import { OrchestrationService } from '../../src/orchestration/orchestration.service.js';
import { QueueModule } from '../../src/queue/queue.module.js';
import { QUEUE_OPTIONS } from '../../src/queue/queue.options.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/** 3.9: orkestratsiya — haqiqiy TimescaleDB; agentd o'rniga soxta sender; lead/ishchi vositalari `MessagingService.handleMailbox` orqali (haqiqiy yo'l). */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let counter = 0;
const dispatched: Array<{ machineId: string; type: string; payload: { commandId: string; type: string; payload: Record<string, unknown> } }> = [];
const busEvents: DomainEvent[] = [];

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 20, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, QueueModule, MessagingModule, OrchestrationModule,
    ],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS).useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS).useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: Object.fromEntries(Object.entries(DEFAULT_COMMANDS_OPTIONS.rateLimits).map(([k]) => [k, [100_000, 60_000]])) })
    .overrideProvider(QUEUE_OPTIONS).useValue({ tickMs: 0, keyFile: null, maxStartingNow: 50, blockWhenExhausted: true })
    .overrideProvider(ORCH_OPTIONS).useValue({ tickMs: 0 })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  app.get(RealtimeBus).subscribe((e) => void busEvents.push(e));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const orch = (): OrchestrationService => svc(OrchestrationService);

interface S {
  machineId: string;
  deviceId: string;
  sessionId: string;
  claude: string;
  projectId: string;
}
interface World {
  machineId: string;
  deviceId: string;
  repoKey: string;
  apiPath: string;
  webPath: string;
  lead: S;
  api: S;
  web: S;
  interactive: S;
  other: S;
}

async function seedSession(machineId: string, deviceId: string, o: { name: string; path: string; repoKey: string | null; kind?: string; status?: string; role?: string }): Promise<S> {
  const found = (await ds.query(`SELECT id FROM projects WHERE machine_id = $1 AND path = $2`, [machineId, o.path])) as Array<{ id: string }>;
  const projectId = found[0]?.id ?? ((await ds.query(`INSERT INTO projects (machine_id, path, name, repo_key) VALUES ($1, $2, $3, $4) RETURNING id`, [machineId, o.path, o.name, o.repoKey])) as Array<{ id: string }>)[0]!.id;
  const claude = `${(++counter).toString(16).padStart(8, '0')}-aaaa-4000-8000-${randomUUID().slice(-12)}`;
  const [s] = (await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, kind, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now(), now()) RETURNING id`,
    [machineId, claude, projectId, o.path, o.name, o.kind ?? 'bg', o.status ?? 'idle'],
  )) as Array<{ id: string }>;
  if (o.role) await ds.query(`INSERT INTO session_roles (session_id, role, source) VALUES ($1, $2, 'owner')`, [s!.id, o.role]);
  return { machineId, deviceId, sessionId: s!.id, claude, projectId };
}

async function world(opts: { messaging?: boolean } = {}): Promise<World> {
  const n = ++counter;
  const [m] = (await ds.query(`INSERT INTO machines (slug, hostname, online, control) VALUES ($1, $1, true, $2::jsonb) RETURNING id`, [`zz-orch-${n}`, JSON.stringify(CONTROL_ON)])) as Array<{ id: string }>;
  const machineId = m!.id;
  const [d] = (await ds.query(`INSERT INTO devices (machine_id, kind, public_key, scopes) VALUES ($1, 'agentd', $2, '{}') RETURNING id`, [machineId, Buffer.alloc(32, (n % 250) + 1)])) as Array<{ id: string }>;
  const deviceId = d!.id;
  svc(AgentDispatchService).register(machineId, {
    deviceId,
    send: (type, payload) => {
      dispatched.push({ machineId, type, payload: payload as never });
      return true;
    },
  });
  const repoKey = `github.com/zz/orch-${n}-${randomBytes(2).toString('hex')}`;
  const apiPath = `/zz/orch${n}/api`;
  const webPath = `/zz/orch${n}/api-web`;
  const lead = await seedSession(machineId, deviceId, { name: 'lead', path: apiPath, repoKey, kind: 'bg' });
  const api = await seedSession(machineId, deviceId, { name: 'api', path: apiPath, repoKey, role: 'backend' });
  const web = await seedSession(machineId, deviceId, { name: 'web', path: webPath, repoKey, role: 'frontend' });
  const interactive = await seedSession(machineId, deviceId, { name: 'int', path: webPath, repoKey, kind: 'interactive', role: 'frontend' });
  // boshqa guruh (repo)
  const other = await seedSession(machineId, deviceId, { name: 'other', path: `/zz/orch${n}/other`, repoKey: `${repoKey}-other`, role: 'backend' });
  await ds.query(`UPDATE projects SET repo_key = $2 WHERE machine_id = $1 AND path = $3`, [machineId, repoKey, webPath]);
  if (opts.messaging !== false) await ds.query(`INSERT INTO messaging_groups (group_key, enabled) VALUES ($1, true) ON CONFLICT (group_key) DO UPDATE SET enabled = true`, [repoKey]);
  return { machineId, deviceId, repoKey, apiPath, webPath, lead, api, web, interactive, other };
}

const parse = (c: unknown): MailboxCall => MailboxCallSchema.parse(c);
const call = (s: S, c: unknown) => svc(MessagingService).handleMailbox(s.machineId, s.deviceId, { reqId: randomUUID(), claudeSessionId: s.claude, call: parse(c) });
const text = (r: { ok: boolean; data?: unknown; error?: { code: string; message: string } }): string => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}: ${r.error?.message}`);
  return (r.data as { text: string }).text;
};
const fail = (r: { ok: boolean; error?: { code: string; message: string } }): string => {
  if (r.ok) throw new Error('expected failure');
  return r.error!.code;
};

const PLAN2 = {
  op: 'orch_plan',
  goal: 'Add phone field end to end',
  steps: [
    { key: 'api', title: 'Add phone column + endpoint', role: 'backend' },
    { key: 'ui', title: 'Phone input', role: 'frontend', depends_on: ['api'] },
  ],
};

async function orchOf(lead: S): Promise<OrchestrationDto> {
  const rows = (await ds.query(`SELECT id FROM orchestrations WHERE lead_session_id = $1 ORDER BY created_at DESC LIMIT 1`, [lead.sessionId])) as Array<{ id: string }>;
  return OrchestrationDto(rows[0]!.id);
}
const OrchestrationDto = async (id: string): Promise<OrchestrationDto> => OrchestrationDtoSchema.parse(await orch().getDto(id));
const stepOf = (o: OrchestrationDto, key: string) => o.steps.find((s) => s.key === key)!;
const actions = async (target: string): Promise<string[]> => (await ds.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY id`, [target])).map((r: { action: string }) => r.action);
const lastDispatch = () => dispatched[dispatched.length - 1]!;
/** H-05: mavjud sessiya nishonlari egasi tomonidan tasdiqlangan deb belgilanadi (alohida testlar tasdiqsiz holatni tekshiradi). */
async function trustTargets(w: World): Promise<void> {
  await ds.query(`UPDATE orchestrations SET confirmed_targets = (SELECT COALESCE(array_agg(id), '{}') FROM sessions WHERE machine_id = $2) WHERE lead_session_id = $1 AND status IN ('planning', 'running', 'failed')`, [w.lead.sessionId, w.machineId]);
}
const dispatchCall = async (w: World, stepId: string, over: Record<string, unknown> = {}) => {
  if (over['trust'] !== false) await trustTargets(w);
  const { trust: _t, ...rest } = over;
  return call(w.lead, { op: 'orch_dispatch', stepId, mode: 'existing_session', prompt: 'Implement the step. token=sk-ant-abcdefghijklmnop', ...rest });
};
/** H-05: egasi tasdig'i + qamrov (mashina, aniq papkalar, default/plan, N ta yangi sessiya). */
async function confirmWithScope(w: World, orchId: string, over: Partial<{ machines: string[]; modes: string[]; maxNewSessions: number; roots: string[] }> = {}): Promise<void> {
  const scope = {
    machines: (over.machines ?? [w.machineId]).map((id) => ({ id, name: 'zz' })),
    cwdRoots: (over.roots ?? [w.apiPath, w.webPath]).map((path) => ({ machineId: w.machineId, path })),
    modes: over.modes ?? ['default', 'plan'],
    maxNewSessions: over.maxNewSessions ?? 3,
  };
  await ds.query(`UPDATE orchestrations SET confirmation = 'exempt_device', confirmed_at = now(), confirmed_by_device_id = $2, scope = $3::jsonb WHERE id = $1`, [orchId, w.deviceId, JSON.stringify(scope)]);
}

describe('reja', () => {
  it('lead reja tuzadi (lead-origin: guruh aloqasi yoqilgan bo\'lishi shart); sikl/takror/ko\'p qadam rad etiladi', async () => {
    const off = await world({ messaging: false });
    expect(fail(await call(off.lead, PLAN2))).toBe('orch_blocked');
    expect((await ds.query(`SELECT count(*)::int AS n FROM orchestrations WHERE lead_session_id = $1`, [off.lead.sessionId]))[0].n).toBe(0);

    const w = await world();
    const cyc = { op: 'orch_plan', goal: 'g', steps: [{ key: 'a', title: 'a', role: 'backend', depends_on: ['b'] }, { key: 'b', title: 'b', role: 'backend', depends_on: ['a'] }] };
    expect(fail(await call(w.lead, cyc))).toBe('orch_invalid');
    const many = { op: 'orch_plan', goal: 'g', steps: Array.from({ length: ORCH_LIMITS.maxSteps }, (_, i) => ({ title: `t${i}`, role: 'backend' })) };
    expect(MailboxCallSchema.safeParse({ ...many, steps: [...many.steps, { title: 'x', role: 'backend' }] }).success).toBe(false); // Zod ham rad etadi
    expect((await ds.query(`SELECT count(*)::int AS n FROM orchestrations WHERE lead_session_id = $1`, [w.lead.sessionId]))[0].n).toBe(0); // rad etilgan reja iz qoldirmaydi

    const out = text(await call(w.lead, PLAN2));
    expect(out).toContain('Reja qabul qilindi: 2 ta qadam');
    const o = await orchOf(w.lead);
    expect(o).toMatchObject({ status: 'running', origin: 'lead', groupKey: w.repoKey, confirmation: null, tokenBudget: ORCH_LIMITS.defaultTokenBudget, maxConcurrent: 3 });
    expect(o.steps.map((s) => [s.key, s.status, s.dependsOn])).toEqual([['api', 'pending', []], ['ui', 'pending', ['api']]]);
    expect(await actions(o.id)).toEqual(expect.arrayContaining(['orchestration.created', 'orchestration.plan_created']));
    expect(fail(await call(w.lead, PLAN2))).toBe('orch_conflict'); // faol orkestratsiya bor
  });

  it('boshqa guruhdagi/loyihasiz sessiya va noma\'lum sessiya', async () => {
    const w = await world();
    const ghost = { ...w.lead, claude: 'ghost-session' };
    expect(fail(await call(ghost, PLAN2))).toBe('orch_not_found');
    const [p] = (await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, cwd, project, kind, status, started_at, status_since, last_seen_at) VALUES ($1, $2, '/nowhere', 'x', 'bg', 'idle', now(), now(), now()) RETURNING id`, [w.machineId, `bare-${randomUUID()}`])) as Array<{ id: string }>;
    const claude = (await ds.query(`SELECT claude_session_id FROM sessions WHERE id = $1`, [p!.id]))[0].claude_session_id as string;
    expect(fail(await call({ ...w.lead, claude }, PLAN2))).toBe('orch_invalid');
  });
});

describe('dispatch qoidalari va ishchi hisoboti', () => {
  it('bog\'liqlik tartibi, ramkali prompt, identity va yakun: orkestratsiya completed', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    let o = await orchOf(w.lead);

    // ui api'ga bog'liq: hozir topshirib bo'lmaydi
    expect(fail(await dispatchCall(w, 'ui', { role: 'frontend' }))).toBe('orch_blocked');
    expect(await actions(o.id)).not.toContain('orchestration.dispatch');

    // api -> mavjud backend sessiya (boshqa guruh sessiyasi tanlanmaydi)
    const before = dispatched.length;
    const out = text(await dispatchCall(w, 'api', { role: 'backend' }));
    expect(out).toContain('topshirildi');
    expect(dispatched.length).toBe(before + 1);
    const sent = lastDispatch();
    expect(sent.payload.type).toBe('session.prompt');
    const prompt = sent.payload.payload['text'] as string;
    expect(prompt.startsWith('[Commander: orkestratsiya.')).toBe(true);
    expect(prompt).toContain('stepId: "' + stepOf(o, 'api').id + '"');
    expect(prompt).toContain('> Implement the step. token=[REDACTED]');
    expect(prompt).not.toContain('sk-ant-abcdefghijklmnop');
    o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'dispatched', assignedSessionId: w.api.sessionId, dispatchMode: 'existing_session' });
    expect(await actions(o.id)).toContain('orchestration.dispatch');
    const au = JSON.stringify((await ds.query(`SELECT details FROM audit_log WHERE target = $1 AND action = 'orchestration.dispatch'`, [o.id])));
    expect(au).not.toContain('sk-ant');
    expect(au).toContain(w.api.sessionId);

    // ishchi bo'lmagan sessiyalar yangilay olmaydi; ishchi o'zining qadamini yangilaydi
    expect(fail(await call(w.web, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'done' }))).toBe('orch_forbidden');
    expect(fail(await call(w.other, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'done' }))).toBe('orch_forbidden');
    expect(fail(await call(w.api, { op: 'orch_step_update', stepId: randomUUID(), status: 'done' }))).toBe('orch_not_found');
    expect(fail(await call(w.api, { op: 'orch_dispatch', stepId: 'ui', mode: 'existing_session', prompt: 'x' }))).toBe('orch_forbidden'); // ishchi dispatch qila olmaydi
    expect(text(await call(w.api, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'in_progress' }))).toContain('-> running');
    expect(text(await call(w.api, { op: 'orch_step_update', stepId: 'api', status: 'done', summary: 'added phone; secret=hunter2hunter2' }))).toContain('-> done');
    o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'done' });
    expect(stepOf(o, 'api').resultSummary).not.toContain('hunter2');
    expect(fail(await call(w.api, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'failed' }))).toBe('orch_conflict'); // yakuniy qadam o'zgarmaydi

    // endi ui; interaktiv sessiya (frontend roli bilan) tanlanmaydi: bo'sh bg web tanlanadi
    expect(text(await dispatchCall(w, 'ui', { role: 'frontend' }))).toContain('topshirildi');
    o = await orchOf(w.lead);
    expect(stepOf(o, 'ui').assignedSessionId).toBe(w.web.sessionId);
    // worker status
    expect(text(await call(w.web, { op: 'orch_status' }))).toContain('SIZNING QADAMINGIZ');
    expect(text(await call(w.web, { op: 'orch_step_update', stepId: stepOf(o, 'ui').id, status: 'done', summary: 'ok' }))).toContain('-> done');
    o = await orchOf(w.lead);
    expect(o.status).toBe('completed');
    expect(o.counts).toMatchObject({ done: 2, pending: 0 });
    expect(o.finishedAt).not.toBeNull();
    expect(fail(await dispatchCall(w, 'ui'))).toBe('orch_blocked');
    expect(await actions(o.id)).toEqual(expect.arrayContaining(['orchestration.step_update', 'orchestration.status']));
    expect(busEvents.some((e) => e.type === 'orchestration.changed' && e.orchestrationId === o.id)).toBe(true);
  });

  it('parallel chegara, mavjud sessiya talablari (band/interaktiv/noma\'lum rol) va qayta urinish', async () => {
    const w = await world();
    await call(w.lead, { op: 'orch_plan', goal: 'g', steps: [{ key: 'a', title: 'a', role: 'backend' }, { key: 'b', title: 'b', role: 'frontend' }, { key: 'c', title: 'c', role: 'mobile' }] });
    const o0 = await orchOf(w.lead);
    await ds.query(`UPDATE orchestrations SET max_concurrent = 1 WHERE id = $1`, [o0.id]);
    expect(text(await dispatchCall(w, 'a', { role: 'backend' }))).toContain('topshirildi');
    expect(fail(await dispatchCall(w, 'b', { role: 'frontend' }))).toBe('orch_limit');
    expect(fail(await dispatchCall(w, 'a', { role: 'backend' }))).toBe('orch_conflict'); // allaqachon faol
    await ds.query(`UPDATE orchestrations SET max_concurrent = 3 WHERE id = $1`, [o0.id]);
    expect(fail(await dispatchCall(w, 'c', { role: 'mobile' }))).toBe('orch_invalid'); // guruhda mobile yo'q
    // band web sessiya (boshqa faol qadam) tanlanmaydi
    await ds.query(`UPDATE sessions SET status = 'working' WHERE id = $1`, [w.web.sessionId]);
    expect(fail(await dispatchCall(w, 'b', { role: 'frontend' }))).toBe('orch_conflict');
    await ds.query(`UPDATE sessions SET status = 'idle' WHERE id = $1`, [w.web.sessionId]);
    // boshqa guruh sessiyasiga id bilan ham yetib bo'lmaydi
    expect(fail(await dispatchCall(w, 'b', { session: w.other.claude.slice(0, 8) }))).toBe('orch_invalid');
    // interaktiv sessiyani aniq ko'rsatish: boshqarib bo'lmaydi
    expect(fail(await dispatchCall(w, 'b', { session: w.interactive.claude.slice(0, 8) }))).toBe('orch_conflict');
    // xato -> qayta urinish (failed qadam qayta topshiriladi)
    const o1 = await orchOf(w.lead);
    await svc(CommandsService).handleResult(w.machineId, { commandId: stepOf(o1, 'a').commandId!, state: 'done', result: {} }); // birinchi prompt yetkazildi
    await call(w.api, { op: 'orch_step_update', stepId: stepOf(o1, 'a').id, status: 'failed', summary: 'tests red' });
    expect((await orchOf(w.lead)).status).toBe('failed');
    await ds.query(`UPDATE sessions SET status = 'idle' WHERE id = $1`, [w.api.sessionId]); // ishchi qaytadan bo'sh
    expect(text(await dispatchCall(w, 'a', { role: 'backend' }))).toContain('topshirildi');
    const o2 = await orchOf(w.lead);
    expect(o2.status).toBe('running');
    expect(stepOf(o2, 'a')).toMatchObject({ status: 'dispatched', resultSummary: null });
  });

  it('token byudjeti: oshgach dispatch bloklanadi, bir marta audit/bayroq; sessiyalar to\'xtatilmaydi', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    const o = await orchOf(w.lead);
    await ds.query(`UPDATE orchestrations SET token_budget = 1000 WHERE id = $1`, [o.id]);
    expect(text(await dispatchCall(w, 'api', { role: 'backend' }))).toContain('topshirildi');
    // lead va ishchi sessiyalarning token sarfi (kesh o'qish hisobga olinmaydi)
    await ds.query(
      `INSERT INTO token_usage (machine_id, request_id, ts, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source) VALUES
       ($1, $2, now(), $3, 'haiku', 300, 200, 9000000, 0, 'otel'), ($1, $4, now(), $5, 'haiku', 100, 100, 0, 300, 'otel')`,
      [w.machineId, `r-${randomUUID()}`, w.lead.claude, `r-${randomUUID()}`, w.api.claude],
    );
    expect((await orch().getDto(o.id)).tokensUsed).toBe(1000);
    expect(await orch().checkBudget(o.id)).toBe(true);
    expect(await orch().checkBudget(o.id)).toBe(false); // bir marta
    expect(await actions(o.id)).toContain('orchestration.budget_exceeded');
    const dto = await orchOf(w.lead);
    expect(dto.budgetExceeded).toBe(true);
    expect(dto.status).toBe('running');
    // boshlanishidan oldingi sarf hisobga olinmaydi
    await ds.query(`INSERT INTO token_usage (machine_id, request_id, ts, session_id, model, input_tokens, output_tokens, source) VALUES ($1, $2, now() - interval '3 days', $3, 'haiku', 5000, 5000, 'otel')`, [w.machineId, `r-${randomUUID()}`, w.lead.claude]);
    expect((await orch().getDto(o.id)).tokensUsed).toBe(1000);
    await call(w.api, { op: 'orch_step_update', stepId: 'api', status: 'done' });
    expect(fail(await dispatchCall(w, 'ui', { role: 'frontend' }))).toBe('orch_blocked');
    expect(dispatched.filter((d) => d.payload.type === 'session.stop').length).toBe(0);
  });

  it('lockdown dispatch\'ni bloklaydi va buyruq yaratilmaydi', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    await svc(LockdownService).set(true, 'test');
    try {
      const n = dispatched.length;
      expect(fail(await dispatchCall(w, 'api', { role: 'backend' }))).toBe('orch_blocked');
      expect(dispatched.length).toBe(n);
      expect(stepOf(await orchOf(w.lead), 'api').status).toBe('pending');
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    expect(text(await dispatchCall(w, 'api', { role: 'backend' }))).toContain('topshirildi');
  });

  it('politika rad etsa (mashina policy o\'chiq) qadam pending\'ga qaytadi va sabab yoziladi', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    await ds.query(`UPDATE machines SET control = $2::jsonb WHERE id = $1`, [w.machineId, JSON.stringify({ ...CONTROL_ON, allowPrompt: false })]);
    expect(fail(await dispatchCall(w, 'api', { role: 'backend' }))).toBe('orch_conflict');
    const o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'pending', assignedSessionId: null });
    expect(stepOf(o, 'api').lastError).toBe('action_not_allowed');
    expect(await actions(o.id)).toContain('orchestration.dispatch_failed');
    await ds.query(`UPDATE machines SET control = $2::jsonb WHERE id = $1`, [w.machineId, JSON.stringify(CONTROL_ON)]);
  });
});

describe('yangi sessiya va navbat dispatch\'i', () => {
  it('cwd guruh loyihalaridan tashqarida: rad; tasdiqsiz orkestratsiyada step-up (Telegram yo\'q => fail-closed)', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    expect(fail(await dispatchCall(w, 'api', { mode: 'new_session', cwd: '/etc' }))).toBe('orch_blocked');
    expect(fail(await dispatchCall(w, 'api', { mode: 'new_session', cwd: `${w.apiPath}/../../etc` }))).toBe('orch_blocked');
    expect(fail(await dispatchCall(w, 'api', { mode: 'new_session' }))).toBe('orch_invalid'); // cwd yo'q
    const n = dispatched.length;
    // tasdiqsiz (lead yaratgan): session.start step-up talab qiladi; Telegram yo'q => buyruq failed, hech narsa yuborilmaydi
    expect(fail(await dispatchCall(w, 'api', { mode: 'new_session', cwd: w.apiPath }))).toBe('orch_conflict');
    expect(dispatched.length).toBe(n);
    const o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'pending', lastError: 'step_up_unavailable' });
    // queue: tasdiqsiz orkestratsiyada rad
    expect(fail(await dispatchCall(w, 'api', { mode: 'queue', cwd: w.apiPath }))).toBe('orch_conflict');
    expect(stepOf(await orchOf(w.lead), 'api').lastError).toBe('confirmation_required');
  });

  it('egasi tasdig\'i yozilgan orkestratsiyada session.start qayta step-up so\'ramaydi; natija sessiyani qadamga bog\'laydi; ishchi hisobot beradi', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    let o = await orchOf(w.lead);
    await confirmWithScope(w, o.id);
    const n = dispatched.length;
    const out = text(await dispatchCall(w, 'api', { mode: 'new_session', cwd: `${w.apiPath}/src`, permissionMode: 'plan' }));
    expect(out).toContain('yangi sessiya');
    expect(dispatched.length).toBe(n + 1);
    const sent = lastDispatch();
    expect(sent.payload.type).toBe('session.start');
    expect(sent.payload.payload).toMatchObject({ cwd: `${w.apiPath}/src`, permissionMode: 'plan' });
    expect(String(sent.payload.payload['prompt'])).toContain('Orkestratsiya #' + o.id.slice(0, 8));
    o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'dispatched', dispatchMode: 'new_session', assignedSessionId: null });
    const cmdId = stepOf(o, 'api').commandId!;

    // agentd sessiyani ochdi: markaz sessiyani bilgach qadamga bog'laydi
    const worker = await seedSession(w.machineId, w.deviceId, { name: 'spawned', path: w.apiPath, repoKey: w.repoKey, status: 'working' });
    await svc(CommandsService).handleResult(w.machineId, { commandId: cmdId, state: 'done', result: { claudeSessionId: worker.claude, shortId: worker.claude.slice(0, 8) } });
    for (let i = 0; i < 100 && !stepOf(await orchOf(w.lead), 'api').assignedSessionId; i++) await new Promise((r) => setTimeout(r, 25));
    expect(stepOf(await orchOf(w.lead), 'api').assignedSessionId).toBe(worker.sessionId);
    expect(text(await call(worker, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'done', summary: 'spawned worker done' }))).toContain('-> done');
    expect(fail(await call(w.api, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'failed' }))).toBe('orch_forbidden');
  });

  it('navbat rejimi: tasdiqlangan orkestratsiyada navbat elementi yaratiladi va qadamga bog\'lanadi; bekor qilinsa qadam failed', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    const o = await orchOf(w.lead);
    await confirmWithScope(w, o.id);
    expect(text(await dispatchCall(w, 'api', { mode: 'queue', cwd: w.apiPath, when: 'machine_idle' }))).toContain('navbat');
    const s = stepOf(await orchOf(w.lead), 'api');
    expect(s).toMatchObject({ status: 'dispatched', dispatchMode: 'queue' });
    expect(s.queueItemId).not.toBeNull();
    const item = (await ds.query(`SELECT status, confirmation, created_by_device_id, prompt_preview FROM task_queue WHERE id = $1`, [s.queueItemId]))[0];
    expect(item).toMatchObject({ confirmation: 'exempt_device', created_by_device_id: w.deviceId });
    expect(item.prompt_preview).not.toContain('sk-ant-abcdefghijklmnop');
    await ds.query(`UPDATE task_queue SET status = 'cancelled' WHERE id = $1`, [s.queueItemId]);
    svc(RealtimeBus).publish({ type: 'queue.changed', queueId: s.queueItemId! });
    for (let i = 0; i < 100 && stepOf(await orchOf(w.lead), 'api').status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(stepOf(await orchOf(w.lead), 'api')).toMatchObject({ status: 'failed', lastError: 'queue_cancelled' });
  });
});

describe('REST: boshlash, ro\'yxat va "To\'xtatish"', () => {
  async function token(scopes: string[], exempt = false): Promise<{ id: string; token: string }> {
    const t = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
    if (exempt) {
      await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = settings.value || $1::jsonb`, [JSON.stringify([t.id])]);
    }
    return { id: t.id, token: t.token };
  }

  it('mavjud lead: boshlang\'ich prompt, tasdiq yozuvi, plan_create to\'ldiradi; lead_busy/guruhga mos emas/403', async () => {
    const w = await world({ messaging: false }); // dashboard-origin: guruh aloqasi shart emas
    const ex = await token(['read', 'control'], true);
    const reader = await token(['read']);
    const body = { goal: 'Phone field. token=sk-ant-abcdefghijklmnop', projectId: w.lead.projectId, lead: { type: 'session', sessionId: w.lead.sessionId }, taskKey: '3.9', maxConcurrent: 2 };
    await http().post('/v1/orchestrations').set(bearer(reader.token)).send(body).expect(403);
    await http().post('/v1/orchestrations').set(bearer(ex.token)).send({ ...body, lead: { type: 'session', sessionId: w.other.sessionId } }).expect(400);
    await http().post('/v1/orchestrations').set(bearer(ex.token)).send({ ...body, taskKey: 'bad key!' }).expect(400);
    await http().post('/v1/orchestrations').set(bearer(ex.token)).send({ ...body, maxConcurrent: 99 }).expect(400);

    const n = dispatched.length;
    const res = await http().post('/v1/orchestrations').set(bearer(ex.token)).send(body).expect(201);
    const dto = OrchestrationDtoSchema.parse(res.body);
    expect(dto).toMatchObject({ status: 'planning', origin: 'dashboard', confirmation: 'exempt_device', taskKey: '3.9', maxConcurrent: 2, leadSessionId: w.lead.sessionId, groupKey: w.repoKey });
    expect(dto.goal).not.toContain('sk-ant-abcdefghijklmnop');
    expect(dto.leadCommandId).not.toBeNull();
    expect(dispatched.length).toBe(n + 1);
    expect(lastDispatch().payload.type).toBe('session.prompt');
    expect(String(lastDispatch().payload.payload['text'])).toContain('commander_plan_create');
    expect(await actions(dto.id)).toContain('orchestration.created');
    await http().post('/v1/orchestrations').set(bearer(ex.token)).send(body).expect(409); // lead band

    // lead rejani to'ldiradi (dashboard-origin, mavjud orkestratsiya)
    expect(text(await call(w.lead, PLAN2))).toContain('2 ta qadam');
    const after = OrchestrationDtoSchema.parse((await http().get(`/v1/orchestrations/${dto.id}`).set(bearer(reader.token)).expect(200)).body);
    expect(after).toMatchObject({ status: 'running', origin: 'dashboard', goal: dto.goal });
    expect(after.steps).toHaveLength(2);
    const list = await http().get(`/v1/orchestrations?projectId=${w.web.projectId}`).set(bearer(reader.token)).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(dto.id);
    await http().get(`/v1/orchestrations/${randomUUID()}`).set(bearer(reader.token)).expect(404);
    await http().get(`/v1/orchestrations/not-a-uuid`).set(bearer(reader.token)).expect(400);
  });

  it('yangi lead: tasdiqsiz qurilmada step-up (Telegram yo\'q => 422 va orkestratsiya bekor); istisno qurilmada session.start', async () => {
    const w = await world({ messaging: false });
    const plain = await token(['read', 'control']);
    const ex = await token(['read', 'control'], true);
    const body = (cwd: string) => ({ goal: 'g', projectId: w.lead.projectId, lead: { type: 'new', machineId: w.machineId, cwd, permissionMode: 'default' } });
    await http().post('/v1/orchestrations').set(bearer(ex.token)).send(body('/etc')).expect(400); // cwd guruh loyihasidan tashqarida
    const bad = await http().post('/v1/orchestrations').set(bearer(plain.token)).send(body(w.apiPath)).expect(422);
    expect(bad.body.error).toBe('step_up_unavailable');
    const aborted = (await ds.query(`SELECT status, cancel_reason FROM orchestrations WHERE group_key = $1 AND created_by_device_id = $2`, [w.repoKey, plain.id]))[0];
    expect(aborted).toMatchObject({ status: 'cancelled' });
    expect(aborted.cancel_reason).toContain('kickoff_step_up_unavailable');

    const n = dispatched.length;
    const ok = await http().post('/v1/orchestrations').set(bearer(ex.token)).send(body(w.apiPath)).expect(201);
    expect(dispatched.length).toBe(n + 1);
    expect(lastDispatch().payload.type).toBe('session.start');
    // agentd lead sessiyani ochdi => orkestratsiyaga bog'lanadi
    const lead2 = await seedSession(w.machineId, w.deviceId, { name: 'lead2', path: w.apiPath, repoKey: w.repoKey, status: 'working' });
    await svc(CommandsService).handleResult(w.machineId, { commandId: ok.body.leadCommandId, state: 'done', result: { claudeSessionId: lead2.claude, shortId: lead2.claude.slice(0, 8) } });
    for (let i = 0; i < 100; i++) {
      if ((await orch().getDto(ok.body.id)).leadSessionId) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect((await orch().getDto(ok.body.id)).leadSessionId).toBe(lead2.sessionId);
    expect(text(await call(lead2, PLAN2))).toContain('2 ta qadam'); // yangi lead o'z orkestratsiyasini to'ldiradi
  });

  it('"To\'xtatish": hamma faol ishtirokchiga session.stop, qadamlar va orkestratsiya cancelled, takror chaqiruv idempotent, keyin dispatch/yangilash bloklanadi', async () => {
    const w = await world();
    const ex = await token(['read', 'control'], true);
    await call(w.lead, PLAN2);
    const o = await orchOf(w.lead);
    await dispatchCall(w, 'api', { role: 'backend' });
    const n = dispatched.length;
    const res = await http().post(`/v1/orchestrations/${o.id}/cancel`).set(bearer(ex.token)).expect(200);
    expect(res.body.orchestration).toMatchObject({ status: 'cancelled', cancelReason: 'owner' });
    expect(res.body.stopped).toBe(2); // lead + faol ishchi (api)
    expect(res.body.stopFailed).toBe(0);
    const stops = dispatched.slice(n).filter((d) => d.payload.type === 'session.stop');
    expect(stops).toHaveLength(2);
    const dto = await orchOf(w.lead);
    expect(dto.steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(await actions(o.id)).toContain('orchestration.cancelled');
    expect(fail(await dispatchCall(w, 'ui', { role: 'frontend' }))).toBe('orch_blocked');
    expect(fail(await call(w.api, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'done' }))).toBe('orch_blocked');
    const again = await http().post(`/v1/orchestrations/${o.id}/cancel`).set(bearer(ex.token)).expect(200);
    expect(again.body.stopped).toBe(0);
    expect(dispatched.slice(n).filter((d) => d.payload.type === 'session.stop')).toHaveLength(2);
    await http().post(`/v1/orchestrations/${randomUUID()}/cancel`).set(bearer(ex.token)).expect(404);
    const reader = await token(['read']);
    await http().post(`/v1/orchestrations/${o.id}/cancel`).set(bearer(reader.token)).expect(403);
  });

  it('ishchi sessiyasi tugasa (hisobotsiz) tik qadamni failed qiladi va orkestratsiya failed', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    await dispatchCall(w, 'api', { role: 'backend' });
    // bg sessiya prompt'dan keyin qayta ochiladi: yaqinda tugagan sessiya (grace ichida) "yo'qolgan" hisoblanmaydi
    await ds.query(`UPDATE sessions SET ended_at = now(), status = 'ended' WHERE id = $1`, [w.api.sessionId]);
    await orch().tick();
    expect(stepOf(await orchOf(w.lead), 'api').status).toBe('dispatched');
    await ds.query(`UPDATE sessions SET ended_at = now() - interval '10 minutes' WHERE id = $1`, [w.api.sessionId]);
    await orch().tick();
    const o = await orchOf(w.lead);
    expect(stepOf(o, 'api')).toMatchObject({ status: 'failed', lastError: 'session_ended' });
    expect(o.status).toBe('failed');
    // tizim adashgan bo'lsa ishchi o'z qadamini tiklay oladi (qayta ochilgan sessiya hisobot beradi)
    await ds.query(`UPDATE sessions SET ended_at = NULL, status = 'working' WHERE id = $1`, [w.api.sessionId]);
    expect(text(await call(w.api, { op: 'orch_step_update', stepId: stepOf(o, 'api').id, status: 'done', summary: 'late report' }))).toContain('-> done');
    expect(stepOf(await orchOf(w.lead), 'api')).toMatchObject({ status: 'done', resultSummary: 'late report' });
    expect((await orchOf(w.lead)).status).toBe('running');
  });
});

describe('H-05: tasdiq qamrovi (scope) va mavjud sessiya tasdig\'i', () => {
  const PLAN3 = {
    op: 'orch_plan',
    goal: 'three independent steps',
    steps: [
      { key: 'a', title: 'a', role: 'backend' },
      { key: 'b', title: 'b', role: 'backend' },
      { key: 'c', title: 'c', role: 'backend' },
    ],
  };
  const newSession = (w: World, step: string, over: Record<string, unknown> = {}) => dispatchCall(w, step, { mode: 'new_session', cwd: w.apiPath, ...over });

  it('qamrov ichida tasdiqsiz o\'tadi va yangi sessiya hisoblanadi; sanoq tugagach keyingisi yangi step-up talab qiladi (Telegram yo\'q => fail-closed)', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    await confirmWithScope(w, o.id, { maxNewSessions: 1 });
    expect(text(await newSession(w, 'a', { permissionMode: 'plan' }))).toContain('yangi sessiya');
    expect((await ds.query(`SELECT new_sessions_used FROM orchestrations WHERE id = $1`, [o.id]))[0].new_sessions_used).toBe(1);
    const n = dispatched.length;
    expect(fail(await newSession(w, 'b'))).toBe('orch_conflict'); // limit tugadi: yangi tasdiq kerak, Telegram yo'q
    expect(dispatched.length).toBe(n);
    expect(stepOf(await orchOf(w.lead), 'b')).toMatchObject({ status: 'pending', lastError: 'step_up_unavailable' });
    const au = JSON.stringify(await ds.query(`SELECT details FROM audit_log WHERE target = $1 AND action = 'orchestration.dispatch' ORDER BY id`, [o.id]));
    expect(au).toContain('"scope_covered":true');
    expect(au).toContain('"scope_miss":"max_sessions"');
    expect((await ds.query(`SELECT new_sessions_used FROM orchestrations WHERE id = $1`, [o.id]))[0].new_sessions_used).toBe(1); // muvaffaqiyatsiz topshirish sanoqni oshirmaydi
  });

  it('acceptEdits, boshqa mashina va papka tasdiq qamroviga kirmaydi: har biri alohida step-up', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    await confirmWithScope(w, o.id);
    const n = dispatched.length;
    expect(fail(await newSession(w, 'a', { permissionMode: 'acceptEdits' }))).toBe('orch_conflict');
    expect(stepOf(await orchOf(w.lead), 'a').lastError).toBe('step_up_unavailable');
    expect(dispatched.length).toBe(n);

    await confirmWithScope(w, o.id, { machines: [randomUUID()] });
    expect(fail(await newSession(w, 'b'))).toBe('orch_conflict');
    await confirmWithScope(w, o.id, { roots: [w.webPath] }); // faqat web papkasi: api papkasi tashqarida
    expect(fail(await newSession(w, 'c'))).toBe('orch_conflict');
    expect(dispatched.length).toBe(n);
    const misses = (await ds.query(`SELECT details->>'scope_miss' AS m FROM audit_log WHERE target = $1 AND action = 'orchestration.dispatch' ORDER BY id`, [o.id])).map((r: { m: string }) => r.m);
    expect(misses).toEqual(['mode', 'machine', 'cwd']);
  });

  it('qamrovsiz (eski/lead yaratgan) orkestratsiya: confirmed_at bo\'lsa ham hech narsa qoplanmaydi; navbat rejimi rad', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    await ds.query(`UPDATE orchestrations SET confirmation = 'exempt_device', confirmed_at = now(), confirmed_by_device_id = $2, scope = NULL WHERE id = $1`, [o.id, w.deviceId]);
    expect(fail(await newSession(w, 'a'))).toBe('orch_conflict');
    expect(stepOf(await orchOf(w.lead), 'a').lastError).toBe('step_up_unavailable');
    expect(fail(await dispatchCall(w, 'b', { mode: 'queue', cwd: w.apiPath }))).toBe('orch_conflict');
    expect(stepOf(await orchOf(w.lead), 'b').lastError).toBe('confirmation_required');
  });

  it('navbat rejimi qamrovdan tashqarida (acceptEdits) rad etiladi', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    await confirmWithScope(w, o.id);
    expect(fail(await dispatchCall(w, 'a', { mode: 'queue', cwd: w.apiPath, permissionMode: 'acceptEdits' }))).toBe('orch_conflict');
    expect(stepOf(await orchOf(w.lead), 'a').lastError).toBe('confirmation_required');
  });

  it('tasdiqlagan qurilma revoke qilinsa orkestratsiya bekor qilinadi (L-22) va qamrov qoplamaydi', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    await confirmWithScope(w, o.id);
    const owner = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-owner-${randomBytes(2).toString('hex')}`, scopes: ['read'] }, 'test');
    await ds.query(`UPDATE orchestrations SET confirmed_by_device_id = $2 WHERE id = $1`, [o.id, owner.id]);
    expect(text(await newSession(w, 'a'))).toContain('yangi sessiya'); // tasdiqlagan qurilma hali amalda: qoplanadi
    await ds.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [owner.id]);
    // revoke DB trigger orqali `device.event` yuboradi: tasdiqlagan qurilmaning faol orkestratsiyasi darhol bekor qilinadi (L-22)
    for (let i = 0; i < 100 && (await orchOf(w.lead)).status !== 'cancelled'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await orchOf(w.lead)).toMatchObject({ status: 'cancelled', cancelReason: 'creator_revoked' });
    expect(fail(await newSession(w, 'b'))).toBe('orch_blocked');
  });

  it('existing_session: guruhda aloqa o\'chiq bo\'lsa rad; nishon birinchi marta egasi tasdig\'ini talab qiladi (fail-closed), tasdiqdan keyin qayta so\'ramaydi', async () => {
    const w = await world();
    await call(w.lead, PLAN3);
    const o = await orchOf(w.lead);
    const n = dispatched.length;
    expect(fail(await dispatchCall(w, 'a', { role: 'backend', trust: false }))).toBe('orch_conflict'); // step-up kanali yo'q
    expect(stepOf(await orchOf(w.lead), 'a')).toMatchObject({ status: 'pending', lastError: 'step_up_unavailable' });
    expect(dispatched.length).toBe(n);

    await ds.query(`UPDATE messaging_groups SET enabled = false WHERE group_key = $1`, [w.repoKey]);
    expect(fail(await dispatchCall(w, 'a', { role: 'backend' }))).toBe('orch_blocked');
    await ds.query(`UPDATE messaging_groups SET enabled = true WHERE group_key = $1`, [w.repoKey]);

    // egasi bu nishonni tasdiqlagan: step-up so'ralmaydi
    await ds.query(`UPDATE orchestrations SET confirmed_targets = ARRAY[$2::uuid] WHERE id = $1`, [o.id, w.api.sessionId]);
    expect(text(await dispatchCall(w, 'a', { role: 'backend', trust: false }))).toContain('topshirildi');
    expect(lastDispatch().payload.type).toBe('session.prompt');
  });
});

describe('L-22: qurilma revoke qilinganda orkestratsiya va navbat bekor qilinadi', () => {
  it('yaratgan qurilma revoke => faol orkestratsiya cancelled (audit bilan)', async () => {
    const w = await world();
    await call(w.lead, PLAN2);
    const o = await orchOf(w.lead);
    await ds.query(`UPDATE orchestrations SET created_by_device_id = $2 WHERE id = $1`, [o.id, w.deviceId]);
    expect(await orch().cancelForRevokedDevice(w.deviceId)).toContain(o.id);
    expect((await orchOf(w.lead)).status).toBe('cancelled');
    expect((await orchOf(w.lead)).cancelReason).toBe('creator_revoked');
  });
});
