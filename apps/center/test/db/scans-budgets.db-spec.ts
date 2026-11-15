import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { BudgetsResponseSchema, ScanDetailSchema, ScanListResponseSchema } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { BudgetWatcherService } from '../../src/budgets/budget-watcher.service.js';
import { BudgetsModule } from '../../src/budgets/budgets.module.js';
import { BudgetsService } from '../../src/budgets/budgets.service.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { CommandsService } from '../../src/commands/commands.service.js';
import { MIGRATIONS, typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { QueueModule } from '../../src/queue/queue.module.js';
import { QUEUE_OPTIONS } from '../../src/queue/queue.options.js';
import { QueueSchedulerService } from '../../src/queue/queue-scheduler.service.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { ScanSchedulerService } from '../../src/scans/scan-scheduler.service.js';
import { ScansController } from '../../src/scans/scans.controller.js';
import { ScansService } from '../../src/scans/scans.service.js';
import { TelegramService } from '../../src/telegram/telegram.service.js';
import { createThrowawayDb, openDataSource } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 6.10 xavfsizlik tekshiruvi + 6.11 kunlik byudjetlar: haqiqiy TimescaleDB (throwaway); agentd o'rniga soxta sender
 * (`AgentDispatchService`), Telegram o'rniga soxta `TelegramService`.
 */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let hw = 0;
const dispatched: Array<{ machineId: string; type: string; payload: { commandId: string; type: string; payload: Record<string, unknown> } }> = [];
const telegramSent: Array<{ text: string; stopSessionId?: string }> = [];
const autoRespond = new Set<string>();

const CONTROL = {
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false,
  projectOps: true, allowProjectRead: true, allowProjectWrite: true, scan: true, allowScan: true,
};
const SECRET = `ghp_${'Q'.repeat(30)}`;

const scanResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ecosystems: ['npm'],
  tools: [{ tool: 'npm-audit', status: 'ok', detail: 'ok', findings: 2 }, { tool: 'secret-scan', status: 'ok', detail: 'ok', findings: 1 }],
  counts: { critical: 1, high: 1, moderate: 0, low: 0, info: 0 },
  vulnCount: 2,
  outdatedCount: 3,
  secretCount: 1,
  envFileCount: 0,
  findings: [
    { kind: 'vulnerability', tool: 'npm-audit', severity: 'critical', package: 'lodash', version: '4.17.10', fixVersion: '4.17.21', advisoryIds: ['GHSA-xxxx-yyyy-zzzz'], title: `Prototype pollution ${SECRET}`, file: null, line: null, rule: null, direct: true },
    { kind: 'secret', tool: 'secret-scan', severity: 'high', package: `leak-${SECRET}`, version: '1.0.0', fixVersion: null, advisoryIds: [], title: 'GitHub token', file: 'src/config.ts', line: 12, rule: 'github-token', direct: null },
  ],
  findingsTotal: 2,
  truncated: false,
  filesScanned: 40,
  durationMs: 1234,
  ...over,
});

beforeAll(async () => {
  db = await createThrowawayDb();
  const fakeTelegram = {
    notifyText: async (text: string, opts: { stopSessionId?: string } = {}): Promise<number> => {
      telegramSent.push({ text, ...(opts.stopSessionId ? { stopSessionId: opts.stopSessionId } : {}) });
      return 1;
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, QueueModule, BudgetsModule,
    ],
    controllers: [ScansController],
    providers: [ScansService, ScanSchedulerService, BudgetWatcherService, { provide: TelegramService, useValue: fakeTelegram }],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS).useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS).useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'session.start': [1000, 60_000], 'session.stop': [1000, 60_000], 'project.scan': [1000, 60_000] } })
    .overrideProvider(QUEUE_OPTIONS).useValue({ tickMs: 0, keyFile: null, maxStartingNow: 50, blockWhenExhausted: false })
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

beforeEach(async () => {
  await ds.query(`DELETE FROM budget_alerts`);
  await ds.query(`DELETE FROM budget_overrides`);
  await ds.query(`DELETE FROM budgets`);
  telegramSent.length = 0;
  await ds.query(`UPDATE task_queue SET status = 'cancelled', next_run_at = NULL WHERE status IN ('queued', 'waiting_trigger', 'starting')`);
  await ds.query(`UPDATE task_queue_runs SET status = 'failed' WHERE status = 'starting'`);
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function newMachine(name: string, opts: { online?: boolean; control?: Record<string, unknown> | null } = {}): Promise<{ machineId: string; deviceId: string }> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: publicKey.export({ format: 'jwk' }).x as string, hardware_id: `hw-sb-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const machineId = res.body.machine_id as string;
  const deviceId = res.body.device_id as string;
  await ds.query(`UPDATE machines SET online = $2, control = $3::jsonb WHERE id = $1`, [machineId, opts.online ?? true, JSON.stringify(opts.control === undefined ? CONTROL : opts.control)]);
  if (opts.online !== false) {
    svc(AgentDispatchService).register(machineId, {
      deviceId,
      send: (type, payload) => {
        const p = payload as { commandId: string; type: string; payload: Record<string, unknown> };
        dispatched.push({ machineId, type, payload: p });
        if (autoRespond.has(machineId) && p.type === 'project.scan') {
          setTimeout(() => {
            void svc(CommandsService).handleAck(machineId, { commandId: p.commandId }).then(() => svc(CommandsService).handleResult(machineId, { commandId: p.commandId, state: 'done', result: { detail: 'x', scan: scanResult() } }));
          }, 20);
        }
        return true;
      },
    });
  }
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

async function project(machineId: string, path: string, repoKey: string | null = null): Promise<string> {
  const [r] = (await ds.query(`SELECT upsert_project($1, $2, $3, NULL, $4) AS id`, [machineId, path, repoKey, repoKey ? 'git' : 'dir'])) as Array<{ id: string }>;
  return r!.id;
}

/** Bugungi (Toshkent kuni) sarf: vaznli = input + 5*output + 1.25*cacheCreation + 0.1*cacheRead. */
async function usage(machineId: string, projectId: string | null, t: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }, ts: Date = new Date()): Promise<void> {
  await ds.query(
    `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
     VALUES ($1, $2, $3, 'sb', $4, 'claude-opus-4-7', $5, $6, $7, $8, 0, 'otel')`,
    [ts, machineId, `rq-${randomUUID()}`, projectId, t.input ?? 0, t.output ?? 0, t.cacheRead ?? 0, t.cacheCreation ?? 0],
  );
}

const putBudget = (token: string, b: unknown) => http().put('/v1/budgets').set(bearer(token)).send(b as object);
const startBody = (machineId: string, cwd: string) => ({ type: 'session.start', machineId, cwd, prompt: 'p', permissionMode: 'plan' });
const postCommand = (token: string, b: unknown) => http().post('/v1/commands').set(bearer(token)).send(b as object);

describe('migratsiya 6.10/6.11', () => {
  it("chk_commands_type ga project.scan qo'shilgan (boshqa turlar saqlanadi); down faqat o'zinikini olib tashlaydi, up qayta tiklaydi", async () => {
    const own = await createThrowawayDb();
    const d = await openDataSource(own.url);
    try {
      await d.runMigrations();
      const typesOf = async (): Promise<string[]> => {
        const [r] = await d.query(`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = 'commands'::regclass AND c.conname = 'chk_commands_type'`);
        return [...(r.def as string).matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]!);
      };
      expect(await typesOf()).toEqual(expect.arrayContaining(['project.scan', 'session.start', 'logs.tail', 'project.ci_status']));
      const latest = async (): Promise<string> => (await d.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`))[0].name as string;
      let guard = 0;
      while ((await latest()) !== 'ScansBudgets1731408100000' && guard++ < MIGRATIONS.length) await d.undoLastMigration();
      await d.undoLastMigration();
      expect(await typesOf()).not.toContain('project.scan');
      expect(await typesOf()).toContain('logs.tail');
      expect(await d.query(`SELECT to_regclass('project_scans') AS a, to_regclass('budgets') AS b, to_regclass('budget_overrides') AS c, to_regclass('budget_alerts') AS d`)).toEqual([{ a: null, b: null, c: null, d: null }]);
      await d.runMigrations();
      expect(await typesOf()).toContain('project.scan');
    } finally {
      await d.destroy();
      await own.drop();
    }
  });
});

describe('project.scan: imzolangan o\'qish buyrug\'i', () => {
  it("POST -> dispatch (step-up YO'Q) -> ack -> natija: project_scans'ga redakt qilingan yoziladi; sir qiymati hech qayerda yo'q", async () => {
    const m = await newMachine('zz-scan-flow');
    const p = await project(m.machineId, '/work/scan-flow', 'github.com/acme/scan-flow');
    const c = await issueToken(['read', 'control']);
    const before = dispatched.length;
    const res = await http().post(`/v1/projects/${p}/scan`).set(bearer(c.token)).expect(201);
    expect(res.body).toMatchObject({ status: 'sent' });
    const d = dispatched.slice(before).find((x) => x.type === 'command.dispatch')!;
    expect(d.payload).toMatchObject({ commandId: res.body.commandId, type: 'project.scan', payload: { root: '/work/scan-flow' } });

    await svc(CommandsService).handleAck(m.machineId, { commandId: res.body.commandId });
    await svc(CommandsService).handleResult(m.machineId, { commandId: res.body.commandId, state: 'done', result: { detail: 'x', scan: scanResult() } });
    const cmd = (await ds.query(`SELECT status, result FROM commands WHERE id = $1`, [res.body.commandId]))[0];
    expect(cmd.status).toBe('done');
    expect(JSON.stringify(cmd.result)).not.toContain('lodash');

    const list = ScanListResponseSchema.parse((await http().get('/v1/scans').set(bearer(c.token)).expect(200)).body);
    const item = list.projects.find((x) => x.projectId === p)!;
    expect(item).toMatchObject({ projectKey: 'github.com/acme/scan-flow', counts: { critical: 1, high: 1 }, vulnCount: 2, secretCount: 1, outdatedCount: 3, partial: false });
    expect(item.trend).toHaveLength(1);
    expect(list.settings).toEqual({ enabled: true, digest: true });
    expect(list.nextRunAt).not.toBeNull();

    const detail = ScanDetailSchema.parse((await http().get(`/v1/scans/${item.scanId}`).set(bearer(c.token)).expect(200)).body);
    expect(detail.findings).toHaveLength(2);
    const secretF = detail.findings.find((f) => f.kind === 'secret')!;
    expect(secretF).toMatchObject({ file: 'src/config.ts', line: 12, rule: 'github-token', package: null, version: null });
    const hist = (await http().get(`/v1/projects/${p}/scans`).set(bearer(c.token)).expect(200)).body as { scans: unknown[] };
    expect(hist.scans).toHaveLength(1);

    // MAXFIYLIK: hech qaysi jadvalda sir qiymati yo'q (markaz qayta redakt qildi)
    const dump = JSON.stringify({
      scans: await ds.query(`SELECT * FROM project_scans`),
      audit: await ds.query(`SELECT details FROM audit_log WHERE target = $1`, [res.body.commandId]),
      commands: await ds.query(`SELECT payload, result FROM commands WHERE id = $1`, [res.body.commandId]),
    });
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('QQQQQQQQQQ');
  });

  it("eski agentd (scan e'lon qilmagan) -> agent_outdated; siyosat allowScan=false -> action_not_allowed; offline -> machine_offline; read token 403", async () => {
    const old = await newMachine('zz-scan-old', { control: { ...CONTROL, scan: undefined, allowScan: undefined } });
    const denied = await newMachine('zz-scan-deny', { control: { ...CONTROL, allowScan: false } });
    const off = await newMachine('zz-scan-off', { online: false });
    const c = await issueToken(['read', 'control']);
    for (const [mm, code] of [[old, 'agent_outdated'], [denied, 'action_not_allowed'], [off, 'machine_offline']] as const) {
      const p = await project(mm.machineId, `/work/${code}`);
      const r = await http().post(`/v1/projects/${p}/scan`).set(bearer(c.token));
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(code);
    }
    const ro = await issueToken(['read']);
    const p2 = await project(old.machineId, '/work/ro');
    await http().post(`/v1/projects/${p2}/scan`).set(bearer(ro.token)).expect(403);
    await http().post(`/v1/projects/${p2}/scan`).expect(401);
  });

  it("yaroqsiz natija -> failed invalid_result, jadvalga hech narsa yozilmaydi; takroriy result bitta qator qoldiradi; saqlash chegarasi", async () => {
    const m = await newMachine('zz-scan-bad');
    const p = await project(m.machineId, '/work/bad');
    const c = await issueToken(['read', 'control']);
    const r = await http().post(`/v1/projects/${p}/scan`).set(bearer(c.token)).expect(201);
    await svc(CommandsService).handleAck(m.machineId, { commandId: r.body.commandId });
    await svc(CommandsService).handleResult(m.machineId, { commandId: r.body.commandId, state: 'done', result: { scan: { nonsense: true } } });
    expect((await ds.query(`SELECT status, error_code FROM commands WHERE id = $1`, [r.body.commandId]))[0]).toEqual({ status: 'failed', error_code: 'invalid_result' });
    expect((await ds.query(`SELECT count(*)::int AS n FROM project_scans WHERE project_id = $1`, [p]))[0].n).toBe(0);

    // ro'yxat tashqarisidagi hisob (kesilgan natija): jami hisob saqlanadi, partial belgisi asbob holatidan
    const r2 = await http().post(`/v1/projects/${p}/scan`).set(bearer(c.token)).expect(201);
    await svc(CommandsService).handleAck(m.machineId, { commandId: r2.body.commandId });
    await svc(CommandsService).handleResult(m.machineId, {
      commandId: r2.body.commandId,
      state: 'done',
      result: { scan: scanResult({ counts: { critical: 9, high: 1, moderate: 0, low: 0, info: 0 }, tools: [{ tool: 'npm-audit', status: 'timeout', detail: 'timeout', findings: 0 }] }) },
    });
    const row = (await ds.query(`SELECT counts, partial FROM project_scans WHERE project_id = $1`, [p]))[0];
    expect(row).toMatchObject({ counts: { critical: 9 }, partial: true });
  });

  it("sozlamalar: GET default, PUT (control) audit bilan, read token 403, yaroqsiz tana 400", async () => {
    const c = await issueToken(['read', 'control']);
    const ro = await issueToken(['read']);
    expect((await http().get('/v1/scan-settings').set(bearer(c.token)).expect(200)).body).toEqual({ enabled: true, digest: true });
    await http().put('/v1/scan-settings').set(bearer(ro.token)).send({ enabled: false, digest: false }).expect(403);
    await http().put('/v1/scan-settings').set(bearer(c.token)).send({ enabled: 'x' }).expect(400);
    await http().put('/v1/scan-settings').set(bearer(c.token)).send({ enabled: false, digest: true }).expect(200);
    expect((await http().get('/v1/scan-settings').set(bearer(c.token))).body).toEqual({ enabled: false, digest: true });
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'scan.settings'`))[0].n).toBeGreaterThan(0);
    await http().put('/v1/scan-settings').set(bearer(c.token)).send({ enabled: true, digest: true }).expect(200);
  });
});

describe('haftalik rejalashtiruvchi', () => {
  it("birinchi tik: skan QILINMAYDI (init); yakshanba 06:00 o'tgach: har repo guruhi bir marta skan qilinadi va Telegram dayjest (faqat critical/high, qiymatsiz); xuddi shu hafta qayta ishga tushmaydi", async () => {
    const sched = svc(ScanSchedulerService);
    await ds.query(`DELETE FROM settings WHERE key = 'scans.schedule'`);
    await ds.query(`DELETE FROM settings WHERE key = 'scans.settings'`);
    const owner = await issueToken(['read', 'control']);
    void owner;
    const a = await newMachine('zz-sched-a');
    const b = await newMachine('zz-sched-b');
    const offline = await newMachine('zz-sched-off', { online: false });
    autoRespond.add(a.machineId);
    autoRespond.add(b.machineId);
    // boshqa testlardan qolgan mashinalar javob bermaydi: ular tanlovga tushmasin
    await ds.query(`UPDATE machines SET online = false WHERE id <> ALL($1::uuid[])`, [[a.machineId, b.machineId]]);
    const pa = await project(a.machineId, '/work/shared', 'github.com/acme/shared');
    await ds.query(`UPDATE projects SET last_snapshot_at = now() WHERE id = $1`, [pa]);
    const pb = await project(b.machineId, '/srv/shared', 'github.com/acme/shared'); // bir repo, boshqa mashina
    await ds.query(`UPDATE projects SET last_snapshot_at = now() - interval '2 days' WHERE id = $1`, [pb]);
    const pc = await project(b.machineId, '/work/only-b');
    await project(offline.machineId, '/work/gone');

    const t0 = new Date('2026-11-15T01:30:00Z'); // yakshanba 06:30 Toshkent
    const n0 = (await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'project.scan'`))[0].n as number;
    expect((await sched.tick(new Date('2026-11-11T10:00:00Z'), true)).kind).toBe('init');
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'project.scan'`))[0].n).toBe(n0);

    const targets = (await sched.targets()).map((t) => t.projectId);
    expect(targets).toContain(pa);
    expect(targets).not.toContain(pb); // bir repo guruhi bir marta (eng yangi faol)
    expect(targets).toContain(pc);

    const act = await sched.tick(t0, true);
    expect(act.kind).toBe('run');
    const scans = await ds.query(`SELECT project_id FROM project_scans WHERE project_id = ANY($1::uuid[])`, [[pa, pc]]);
    expect(scans.map((r: { project_id: string }) => r.project_id).sort()).toEqual([pa, pc].sort());
    expect(telegramSent.length).toBeGreaterThan(0);
    const digest = telegramSent.map((x) => x.text).join('\n');
    expect(digest).toContain('Haftalik xavfsizlik');
    expect(digest).toContain('lodash');
    expect(digest).not.toContain(SECRET);
    expect(digest).not.toContain('QQQQQQQQQQ');
    expect(JSON.stringify(await sched.tick(t0, true))).toContain('idle');
    const sys = await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'project.scan' AND requested_by_device_id IS NOT NULL`);
    expect(sys[0].n).toBeGreaterThanOrEqual(2);
    autoRespond.delete(a.machineId);
    autoRespond.delete(b.machineId);
  });

  it('enabled=false: yakshanba o\'tsa ham skan boshlanmaydi', async () => {
    await ds.query(`INSERT INTO settings (key, value) VALUES ('scans.settings', '{"enabled":false,"digest":true}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await ds.query(`INSERT INTO settings (key, value) VALUES ('scans.schedule', '{"dueKey":"2026-11-01","runStartedAt":null,"digestPending":false}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const before = (await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'project.scan'`))[0].n as number;
    expect((await svc(ScanSchedulerService).tick(new Date('2026-12-06T02:00:00Z'), true)).kind).toBe('idle');
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE type = 'project.scan'`))[0].n).toBe(before);
    await ds.query(`DELETE FROM settings WHERE key IN ('scans.settings', 'scans.schedule')`);
  });
});

describe('byudjet: sozlash va hisoblash', () => {
  it("PUT: control kerak (read 403), min chegara 400, noma'lum loyiha/mashina 404, null olib tashlaydi; audit; GET holat (soft 80%)", async () => {
    const m = await newMachine('zz-b-put');
    const p = await project(m.machineId, '/work/b-put', 'github.com/acme/b-put');
    const c = await issueToken(['read', 'control']);
    const ro = await issueToken(['read']);
    await putBudget(ro.token, { scopeKind: 'project', scopeKey: 'github.com/acme/b-put', dailyTokens: 20_000 }).expect(403);
    await putBudget(c.token, { scopeKind: 'project', scopeKey: 'github.com/acme/b-put', dailyTokens: 500 }).expect(400);
    await putBudget(c.token, { scopeKind: 'project', scopeKey: 'github.com/acme/nope', dailyTokens: 20_000 }).expect(404);
    await putBudget(c.token, { scopeKind: 'machine', scopeKey: randomUUID(), dailyTokens: 20_000 }).expect(404);
    await putBudget(c.token, { scopeKind: 'machine', scopeKey: 'not-a-uuid', dailyTokens: 20_000 }).expect(404);

    await usage(m.machineId, p, { output: 3200 }); // 3200 * 5 = 16 000 = 80%
    const res = BudgetsResponseSchema.parse((await putBudget(c.token, { scopeKind: 'project', scopeKey: 'github.com/acme/b-put', dailyTokens: 20_000, autoStop: true }).expect(200)).body);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ scopeKind: 'project', scopeKey: 'github.com/acme/b-put', usedToday: 16_000, effectiveLimit: 20_000, pct: 80, state: 'soft', autoStop: true });
    expect(res.resetsAt > new Date().toISOString()).toBe(true);
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'budget.set'`))[0].n).toBeGreaterThan(0);

    await usage(m.machineId, p, { cacheRead: 40_000 }); // +4000 = 20 000 = 100%
    const hard = BudgetsResponseSchema.parse((await http().get('/v1/budgets').set(bearer(c.token)).expect(200)).body);
    expect(hard.items[0]).toMatchObject({ usedToday: 20_000, pct: 100, state: 'hard' });
    const removed = BudgetsResponseSchema.parse((await putBudget(c.token, { scopeKind: 'project', scopeKey: 'github.com/acme/b-put', dailyTokens: null }).expect(200)).body);
    expect(removed.items).toHaveLength(0);
  });

  it("kechagi sarf va kechagi override bugunga ta'sir qilmaydi (Toshkent kuni chegarasi)", async () => {
    const m = await newMachine('zz-b-day');
    const p = await project(m.machineId, '/work/b-day', 'github.com/acme/b-day');
    const c = await issueToken(['read', 'control']);
    await usage(m.machineId, p, { output: 50_000 }, new Date(Date.now() - 36 * 3_600_000));
    await putBudget(c.token, { scopeKind: 'machine', scopeKey: m.machineId, dailyTokens: 20_000 }).expect(200);
    await ds.query(`INSERT INTO budget_overrides (scope_kind, scope_key, day, extra_tokens) VALUES ('machine', $1, (now() AT TIME ZONE 'Asia/Tashkent')::date - 1, 99999)`, [m.machineId]);
    const res = BudgetsResponseSchema.parse((await http().get('/v1/budgets').set(bearer(c.token)).expect(200)).body);
    expect(res.items[0]).toMatchObject({ usedToday: 0, extraToday: 0, state: 'ok' });
  });
});

describe('qattiq chegara: yangi session.start (dashboard/Telegram yo\'li)', () => {
  it("loyiha byudjeti (repo guruhi, cwd ichki papka, boshqa mashina sarfi ham) rad etadi: rejected + budget_exceeded (o'zbekcha), dispatch YO'Q, audit; boshqa loyiha o'tadi; override ruxsat beradi", async () => {
    const a = await newMachine('zz-g-a');
    const b = await newMachine('zz-g-b');
    const pa = await project(a.machineId, '/work/gate', 'github.com/acme/gate');
    const pb = await project(b.machineId, '/srv/gate', 'github.com/acme/gate');
    await project(a.machineId, '/work/other', 'github.com/acme/other');
    const t = await exemptToken();
    await putBudget(t.token, { scopeKind: 'project', scopeKey: 'github.com/acme/gate', dailyTokens: 20_000 }).expect(200);
    await usage(a.machineId, pa, { output: 1000 }); // 5000
    await usage(b.machineId, pb, { output: 3000 }); // 15000 -> jami 20 000 (boshqa mashinadagi nusxa ham sanaladi)

    const before = dispatched.length;
    const res = await postCommand(t.token, startBody(a.machineId, '/work/gate/packages/web'));
    expect(res.status).toBeLessThan(300);
    expect(res.body.command).toMatchObject({ status: 'rejected', errorCode: 'budget_exceeded' });
    expect(res.body.command.errorMessage).toContain('Kunlik byudjet tugadi');
    expect(res.body.command.errorMessage).toContain('gate');
    expect(dispatched.length).toBe(before);
    const created = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [res.body.command.id]);
    expect(created[0].details).toMatchObject({ type: 'session.start', status: 'rejected', reason: 'budget_exceeded' });

    // boshqa loyiha/mashina: o'tadi
    const ok = await postCommand(t.token, startBody(a.machineId, '/work/other'));
    expect(ok.body.command.status).toBe('sent');
    // loyihasiz cwd faqat mashina byudjetiga tushadi (mashina byudjeti yo'q): o'tadi
    expect((await postCommand(t.token, startBody(a.machineId, '/tmp/nowhere'))).body.command.status).toBe('sent');

    // override: "bugun uchun +X" (control; audit)
    const ov = await http().post('/v1/budgets/override').set(bearer(t.token)).send({ scopeKind: 'project', scopeKey: 'github.com/acme/gate', extraTokens: 10_000 }).expect(201);
    expect(BudgetsResponseSchema.parse(ov.body).items[0]).toMatchObject({ extraToday: 10_000, effectiveLimit: 30_000, state: 'ok' });
    expect((await ds.query(`SELECT details FROM audit_log WHERE action = 'budget.override' ORDER BY id DESC LIMIT 1`))[0].details).toMatchObject({ extra_tokens: 10_000 });
    expect((await postCommand(t.token, startBody(a.machineId, '/work/gate'))).body.command.status).toBe('sent');
    await http().post('/v1/budgets/override').set(bearer(t.token)).send({ scopeKind: 'project', scopeKey: 'github.com/acme/none', extraTokens: 5 }).expect(404);
    const ro = await issueToken(['read']);
    await http().post('/v1/budgets/override').set(bearer(ro.token)).send({ scopeKind: 'project', scopeKey: 'github.com/acme/gate', extraTokens: 5 }).expect(403);
  });

  it("mashina byudjeti: mashinadagi barcha loyihalar; boshqa mashina ta'sirlanmaydi; check() va checkSession() (orkestratsiya yo'li)", async () => {
    const a = await newMachine('zz-g-m');
    const other = await newMachine('zz-g-o');
    const t = await exemptToken();
    await putBudget(t.token, { scopeKind: 'machine', scopeKey: a.machineId, dailyTokens: 10_000 }).expect(200);
    await usage(a.machineId, null, { output: 2000 }); // 10 000
    const r = await postCommand(t.token, startBody(a.machineId, '/anything'));
    expect(r.body.command).toMatchObject({ status: 'rejected', errorCode: 'budget_exceeded' });
    expect(r.body.command.errorMessage).toContain('mashina');
    expect((await postCommand(t.token, startBody(other.machineId, '/anything'))).body.command.status).toBe('sent');

    const [s] = (await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, cwd, project, kind, status, started_at, status_since, last_seen_at) VALUES ($1, $2, '/x', 'x', 'bg', 'idle', now(), now(), now()) RETURNING id`, [a.machineId, `s-${randomUUID()}`])) as Array<{ id: string }>;
    const budgets = svc(BudgetsService);
    expect(await budgets.checkSession(s!.id)).toMatchObject({ scopeKind: 'machine', limit: 10_000 });
    expect(await budgets.check(other.machineId, '/anything')).toBeNull();
    expect(await budgets.checkSession(randomUUID())).toBeNull();
  });

  it("byudjet yo'q mashina/loyiha uchun gate hech narsani o'zgartirmaydi", async () => {
    const m = await newMachine('zz-g-none');
    const t = await exemptToken();
    expect((await postCommand(t.token, startBody(m.machineId, '/work/free'))).body.command.status).toBe('sent');
  });
});

describe('navbat: qattiq chegarada ishga tushmaydi (kutadi), override keyin ishga tushadi', () => {
  it("element 'budget_exceeded' bilan kechiktiriladi (urinish sanalmaydi, dispatch yo'q); +X dan keyin ishga tushadi", async () => {
    const m = await newMachine('zz-q-b');
    const p = await project(m.machineId, '/work/qb', 'github.com/acme/qb');
    const t = await exemptToken();
    await putBudget(t.token, { scopeKind: 'project', scopeKey: 'github.com/acme/qb', dailyTokens: 10_000 }).expect(200);
    await usage(m.machineId, p, { output: 2000 });
    const item = (await http().post('/v1/queue').set(bearer(t.token)).send({ machineId: m.machineId, cwd: '/work/qb', prompt: 'do it', permissionMode: 'plan', trigger: { type: 'now' } }).expect(201)).body as { id: string };
    const before = dispatched.filter((d) => d.machineId === m.machineId).length;
    await svc(QueueSchedulerService).tick(new Date(Date.now() + 1000));
    const row = (await ds.query(`SELECT status, attempts, last_error_code, next_run_at FROM task_queue WHERE id = $1`, [item.id]))[0];
    expect(row).toMatchObject({ attempts: 0, last_error_code: 'budget_exceeded' });
    expect(row.status).not.toBe('failed');
    expect(dispatched.filter((d) => d.machineId === m.machineId).length).toBe(before);

    await http().post('/v1/budgets/override').set(bearer(t.token)).send({ scopeKind: 'project', scopeKey: 'github.com/acme/qb', extraTokens: 50_000 }).expect(201);
    await ds.query(`UPDATE task_queue SET next_run_at = now() WHERE id = $1`, [item.id]);
    await svc(QueueSchedulerService).tick(new Date(Date.now() + 2000));
    expect(dispatched.filter((d) => d.machineId === m.machineId && d.type === 'command.dispatch').length).toBeGreaterThan(before);
    await sleep(50);
  });
});

describe('byudjet kuzatuvchisi: Telegram ogohlantirish, "To\'xtatish" tugmasi, avto-to\'xtatish', () => {
  it("soft: bir marta (qayta tikda yo'q); hard: ogohlantirish + ishlayotgan sessiyalarga To'xtatish tugmasi, avto-to'xtatish YOQILMAGAN bo'lsa session.stop YO'Q; override alertni tiklaydi", async () => {
    const m = await newMachine('zz-w1');
    const p = await project(m.machineId, '/work/w1', 'github.com/acme/w1');
    const t = await exemptToken();
    await putBudget(t.token, { scopeKind: 'project', scopeKey: 'github.com/acme/w1', dailyTokens: 20_000 }).expect(200);
    const mk = async (status: string): Promise<string> => {
      const [r] = (await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, name, kind, status, started_at, status_since, last_seen_at) VALUES ($1, $2, $3, '/work/w1', 'w1', $4, 'bg', $5, now(), now(), now()) RETURNING id`, [m.machineId, `w-${randomUUID()}`, p, `sess-${status}`, status])) as Array<{ id: string }>;
      return r!.id;
    };
    const working = await mk('working');
    await mk('idle');
    const watcher = svc(BudgetWatcherService);

    await usage(m.machineId, p, { output: 3300 }); // 16 500 = 82%
    expect(await watcher.tick()).toBe(1);
    expect(telegramSent.at(-1)!.text).toContain('80%');
    expect(await watcher.tick()).toBe(0);
    expect(telegramSent).toHaveLength(1);

    await usage(m.machineId, p, { output: 1000 }); // 21 500 -> hard
    const dBefore = dispatched.length;
    expect(await watcher.tick()).toBe(1);
    const texts = telegramSent.map((x) => x.text);
    expect(texts.some((x) => x.includes('Kunlik byudjet tugadi'))).toBe(true);
    const stopCards = telegramSent.filter((x) => x.stopSessionId);
    expect(stopCards.map((x) => x.stopSessionId)).toEqual([working]); // faqat ishlayotgan (working), idle emas
    expect(dispatched.length).toBe(dBefore); // avto-to'xtatish yo'q: hech narsa yuborilmadi
    expect(await watcher.tick()).toBe(0);
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'budget.hard_reached'`))[0].n).toBeGreaterThan(0);

    // override: ogohlantirishlar qayta ishga tushadi
    await http().post('/v1/budgets/override').set(bearer(t.token)).send({ scopeKind: 'project', scopeKey: 'github.com/acme/w1', extraTokens: 3_000 }).expect(201);
    expect(await watcher.tick()).toBe(1); // 21 500 / 23 000 = 93%: soft qayta
    expect(telegramSent.at(-1)!.text).toContain('80%');
  });

  it("autoStop yoqilgan: qattiq chegarada ishlayotgan sessiyalarga imzolangan session.stop (tizim aktori, audit)", async () => {
    const m = await newMachine('zz-w2');
    const p = await project(m.machineId, '/work/w2', 'github.com/acme/w2');
    const t = await exemptToken();
    await putBudget(t.token, { scopeKind: 'machine', scopeKey: m.machineId, dailyTokens: 10_000, autoStop: true }).expect(200);
    const [s] = (await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, kind, status, started_at, status_since, last_seen_at) VALUES ($1, $2, $3, '/work/w2', 'w2', 'bg', 'working', now(), now(), now()) RETURNING id, claude_session_id`, [m.machineId, `w-${randomUUID()}`, p])) as Array<{ id: string; claude_session_id: string }>;
    await usage(m.machineId, p, { output: 2500 });
    const before = dispatched.length;
    expect(await svc(BudgetWatcherService).tick()).toBe(1);
    const stops = dispatched.slice(before).filter((d) => d.type === 'command.dispatch' && d.payload.type === 'session.stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.payload.payload).toMatchObject({ claudeSessionId: s!.claude_session_id });
    const cmd = (await ds.query(`SELECT requested_by_device_id FROM commands WHERE id = $1`, [stops[0]!.payload.commandId]))[0];
    expect(cmd.requested_by_device_id).toBe(t.id);
    expect(telegramSent.some((x) => x.text.includes('avto-to\'xtatish'))).toBe(true);
  });
});
