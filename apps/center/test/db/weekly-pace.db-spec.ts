import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { LimitsResponseSchema, PaceSettingsResponseSchema } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { PaceModule } from '../../src/limits/pace.module.js';
import { PaceWatcherService } from '../../src/limits/pace-watcher.service.js';
import { QueueModule } from '../../src/queue/queue.module.js';
import { QUEUE_OPTIONS } from '../../src/queue/queue.options.js';
import { QueueSchedulerService } from '../../src/queue/queue-scheduler.service.js';
import { tashkentDayOf, tashkentDayStart } from '../../src/projects/tashkent-day.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { TelegramService } from '../../src/telegram/telegram.service.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 6.12 haftalik limit tezligi: haqiqiy TimescaleDB (throwaway); agentd o'rniga soxta sender, Telegram o'rniga soxta `TelegramService`.
 * Vaqt: haqiqiy soat. Hafta oynasi `resetsAt = hozir + 3 kun` (oyna boshi 4 kun oldin, ya'ni kun boshi = Toshkent yarim kechasi).
 */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let hw = 0;
const dispatched: Array<{ machineId: string; type: string }> = [];
const telegramSent: string[] = [];
const DAY = 86_400_000;

const CONTROL = {
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false,
  projectOps: true, allowProjectRead: true, allowProjectWrite: true, scan: true, allowScan: true,
};

beforeAll(async () => {
  db = await createThrowawayDb();
  const fakeTelegram = {
    notifyText: async (text: string): Promise<number> => {
      telegramSent.push(text);
      return 1;
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, QueueModule, PaceModule,
    ],
    providers: [PaceWatcherService, { provide: TelegramService, useValue: fakeTelegram }],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS).useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS).useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'session.start': [1000, 60_000] } })
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
  await ds.query(`DELETE FROM pace_alerts`);
  await ds.query(`DELETE FROM settings WHERE key LIKE 'limits.pace%'`);
  await ds.query(`DELETE FROM limit_samples`);
  await ds.query(`DELETE FROM token_usage`);
  telegramSent.length = 0;
  await ds.query(`UPDATE task_queue SET status = 'cancelled', next_run_at = NULL WHERE status IN ('queued', 'waiting_trigger', 'starting')`);
  await ds.query(`UPDATE task_queue_runs SET status = 'failed' WHERE status = 'starting'`);
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newMachine(name: string): Promise<{ machineId: string; deviceId: string }> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: publicKey.export({ format: 'jwk' }).x as string, hardware_id: `hw-pc-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const machineId = res.body.machine_id as string;
  const deviceId = res.body.device_id as string;
  await ds.query(`UPDATE machines SET online = true, control = $2::jsonb WHERE id = $1`, [machineId, JSON.stringify(CONTROL)]);
  svc(AgentDispatchService).register(machineId, { deviceId, send: (type) => (dispatched.push({ machineId, type }), true) });
  return { machineId, deviceId };
}

async function issueToken(scopes: string[]): Promise<{ id: string; token: string }> {
  const t = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-${randomBytes(2).toString('hex')}`, scopes }, 'test');
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

const sample = (machineId: string, ts: Date, pct: number, resetsAt: Date) =>
  ds.query(`INSERT INTO limit_samples (ts, machine_id, source, seven_day_used_pct, seven_day_resets_at) VALUES ($1, $2, 'official', $3, $4)`, [ts, machineId, pct, resetsAt]);

/** Kun boshidagi 40% (kecha 23:00 Toshkent) va hozirgi `pct` (10 s oldin, yangi) kuzatuv; oyna 3 kundan keyin tugaydi. */
async function seedWeek(machineId: string, nowPct: number, now = new Date()): Promise<{ resetsAt: Date; midnight: Date }> {
  const midnight = tashkentDayStart(tashkentDayOf(now));
  const resetsAt = new Date(now.getTime() + 3 * DAY);
  await sample(machineId, new Date(midnight.getTime() - 3_600_000), 40, resetsAt);
  await sample(machineId, new Date(now.getTime() - 10_000), nowPct, resetsAt);
  return { resetsAt, midnight };
}

const getLimits = async (token: string) => LimitsResponseSchema.parse((await http().get('/v1/limits').set(bearer(token)).expect(200)).body);
const startBody = (machineId: string) => ({ type: 'session.start', machineId, cwd: '/work/pace', prompt: 'p', permissionMode: 'plan' });
const postCommand = (token: string, b: unknown) => http().post('/v1/commands').set(bearer(token)).send(b as object);
const putSettings = (token: string, b: unknown) => http().put('/v1/limits/pace-settings').set(bearer(token)).send(b as object);

describe('migratsiya 6.12', () => {
  it('pace_alerts jadvali mavjud', async () => {
    expect(await ds.query(`SELECT to_regclass('pace_alerts') IS NOT NULL AS ok`)).toEqual([{ ok: true }]);
  });
});

describe('GET /v1/limits: pace', () => {
  it('rasmiy kuzatuv yo\'q: pace yo\'q (to\'qilmaydi); kuzatuvlar bor: kun boshi = yarim kechadan oldingi kuzatuv', async () => {
    const t = await issueToken(['read']);
    const none = await getLimits(t.token);
    expect(none.sevenDay).toBeNull();
    expect(none.pace ?? null).toBeNull();

    const m = await newMachine('zz-pace-api');
    const { resetsAt, midnight } = await seedWeek(m.machineId, 49.8);
    const l = await getLimits(t.token);
    const p = l.pace!;
    expect(p).toBeTruthy();
    expect(p).toMatchObject({ dayStartPct: 40, dayStartFrom: 'prev_sample', source: 'official', stale: false, enabled: true, enforce: false, blocked: false, overriddenToday: false, softPct: 80, hardPct: 100 });
    expect(p.usedTodayPct).toBeCloseTo(9.8, 2);
    expect(p.currentPct).toBeCloseTo(49.8, 2);
    const remaining = (resetsAt.getTime() - midnight.getTime()) / DAY;
    expect(p.remainingDays).toBeCloseTo(remaining, 1);
    expect(p.allowancePct).toBeCloseTo(60 / remaining, 1);
    expect(p.pctOfAllowance).toBeCloseTo((9.8 / (60 / remaining)) * 100, 0);
    expect(new Date(p.resetsAt).getTime()).toBe(resetsAt.getTime());
    expect(new Date(p.dayStartsAt).getTime()).toBe(midnight.getTime());
    expect(p.expectedPct).toBeCloseTo((4 / 7) * 100, 0);
    expect(p.alertsToday).toEqual({ soft: null, hard: null });
  });

  it('oyna kun ichida yangilangan: 0 dan qayta boshlanadi (window_start), eski oyna kuzatuvlari e\'tiborsiz', async () => {
    const t = await issueToken(['read']);
    const m = await newMachine('zz-pace-reset');
    const now = new Date();
    const midnight = tashkentDayStart(tashkentDayOf(now));
    const resetsAt = new Date(midnight.getTime() + 7 * DAY + 30_000); // oyna boshi = yarim kecha + 30 s
    await sample(m.machineId, new Date(midnight.getTime() - 3_600_000), 97, new Date(midnight.getTime() + 30_000)); // eski oyna
    await sample(m.machineId, new Date(now.getTime() - 5_000), 2, resetsAt);
    const p = (await getLimits(t.token)).pace!;
    expect(p).toMatchObject({ dayStartPct: 0, dayStartFrom: 'window_start' });
    expect(p.usedTodayPct).toBeCloseTo(2, 2);
    expect(p.allowancePct).toBeCloseTo(100 / ((resetsAt.getTime() - (midnight.getTime() + 30_000)) / DAY), 1);
  });

  it('kuzatuv eskirgan (kalibrlashsiz): rasmiy qiymat, stale=true', async () => {
    const t = await issueToken(['read']);
    const m = await newMachine('zz-pace-stale');
    const now = new Date();
    const midnight = tashkentDayStart(tashkentDayOf(now));
    const resetsAt = new Date(now.getTime() + 3 * DAY);
    await sample(m.machineId, new Date(midnight.getTime() - 3_600_000), 40, resetsAt);
    await sample(m.machineId, new Date(now.getTime() - 3_600_000), 45, resetsAt);
    const p = (await getLimits(t.token)).pace!;
    expect(p.stale).toBe(true);
    expect(p.source).toBe('official');
    expect(p.currentPct).toBeCloseTo(45, 2);
  });
});

describe('sozlamalar va "bugun uchun ruxsat"', () => {
  it('GET default; PUT control kerak (read 403), yaroqsiz tana 400, audit; override + reset audit', async () => {
    const ro = await issueToken(['read']);
    const t = await exemptToken();
    const def = PaceSettingsResponseSchema.parse((await http().get('/v1/limits/pace-settings').set(bearer(ro.token)).expect(200)).body);
    expect(def.settings).toEqual({ enabled: true, softPct: 80, hardPct: 100, enforce: false });
    expect(def.overriddenToday).toBe(false);

    await putSettings(ro.token, { enforce: true }).expect(403);
    await putSettings(t.token, {}).expect(400);
    await putSettings(t.token, { softPct: 90, hardPct: 90 }).expect(400);
    await putSettings(t.token, { softPct: 100 }).expect(400); // hardPct default 100 ga teng
    await putSettings(t.token, { bogus: 1 }).expect(400);
    const ok = PaceSettingsResponseSchema.parse((await putSettings(t.token, { enforce: true, softPct: 70, hardPct: 120 }).expect(200)).body);
    expect(ok.settings).toEqual({ enabled: true, softPct: 70, hardPct: 120, enforce: true });
    expect((await ds.query(`SELECT details FROM audit_log WHERE action = 'limits.pace_settings' ORDER BY id DESC LIMIT 1`))[0].details).toMatchObject({ enforce: true, softPct: 70, hardPct: 120 });

    await http().post('/v1/limits/pace-override').set(bearer(ro.token)).send({}).expect(403);
    const ov = PaceSettingsResponseSchema.parse((await http().post('/v1/limits/pace-override').set(bearer(t.token)).send({}).expect(201)).body);
    expect(ov.overriddenToday).toBe(true);
    expect((await ds.query(`SELECT details FROM audit_log WHERE action = 'limits.pace_override' ORDER BY id DESC LIMIT 1`))[0].details).toMatchObject({ day: ov.day });
    const cleared = PaceSettingsResponseSchema.parse((await http().post('/v1/limits/pace-override').set(bearer(t.token)).send({ reset: true }).expect(201)).body);
    expect(cleared.overriddenToday).toBe(false);
    expect((await ds.query(`SELECT 1 FROM audit_log WHERE action = 'limits.pace_override_cleared'`)).length).toBe(1);

    // kechagi ruxsat bugunga ta'sir qilmaydi
    await ds.query(`INSERT INTO settings (key, value) VALUES ('limits.pace_override', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ day: '2000-01-01' })]);
    expect((await http().get('/v1/limits/pace-settings').set(bearer(ro.token)).expect(200)).body.overriddenToday).toBe(false);
  });
});

describe('majburlash: yangi session.start va navbat', () => {
  it("default (O'CHIQ): ulush tugasa ham o'tadi; yoqilsa rejected + weekly_pace_exceeded (o'zbekcha), dispatch YO'Q, audit; ruxsat o'tkazadi; bekor qilsa yana rad", async () => {
    const m = await newMachine('zz-pace-gate');
    const t = await exemptToken();
    await seedWeek(m.machineId, 70); // bugun 30% > ulush (~15%)
    const l = await getLimits(t.token);
    expect(l.pace!.status).toBe('exceeded');
    expect(l.pace!.blocked).toBe(false);

    expect((await postCommand(t.token, startBody(m.machineId))).body.command.status).toBe('sent');

    await putSettings(t.token, { enforce: true }).expect(200);
    expect((await getLimits(t.token)).pace!.blocked).toBe(true);
    const before = dispatched.length;
    const res = await postCommand(t.token, startBody(m.machineId));
    expect(res.status).toBeLessThan(300);
    expect(res.body.command).toMatchObject({ status: 'rejected', errorCode: 'weekly_pace_exceeded' });
    expect(res.body.command.errorMessage).toContain('Haftalik limitning bugungi ulushi tugadi');
    expect(dispatched.length).toBe(before);
    const created = await ds.query(`SELECT details FROM audit_log WHERE action = 'command.created' AND target = $1`, [res.body.command.id]);
    expect(created[0].details).toMatchObject({ type: 'session.start', status: 'rejected', reason: 'weekly_pace_exceeded' });

    // bugun uchun ruxsat
    await http().post('/v1/limits/pace-override').set(bearer(t.token)).send({}).expect(201);
    expect((await getLimits(t.token)).pace).toMatchObject({ blocked: false, overriddenToday: true });
    expect((await postCommand(t.token, startBody(m.machineId))).body.command.status).toBe('sent');
    await http().post('/v1/limits/pace-override').set(bearer(t.token)).send({ reset: true }).expect(201);
    expect((await postCommand(t.token, startBody(m.machineId))).body.command).toMatchObject({ status: 'rejected', errorCode: 'weekly_pace_exceeded' });

    // enabled=false: majburlash ham o'chadi
    await putSettings(t.token, { enabled: false }).expect(200);
    expect((await postCommand(t.token, startBody(m.machineId))).body.command.status).toBe('sent');
  });

  it("navbat: 'weekly_pace_exceeded' bilan kechiktiriladi (urinish sanalmaydi, muvaffaqiyatsiz emas, dispatch yo'q); ruxsatdan keyin ishga tushadi", async () => {
    const m = await newMachine('zz-pace-queue');
    const t = await exemptToken();
    await seedWeek(m.machineId, 70);
    await putSettings(t.token, { enforce: true }).expect(200);
    const item = (await http().post('/v1/queue').set(bearer(t.token)).send({ machineId: m.machineId, cwd: '/work/pace', prompt: 'do it', permissionMode: 'plan', trigger: { type: 'now' } }).expect(201)).body as { id: string };
    const before = dispatched.filter((d) => d.machineId === m.machineId).length;
    await svc(QueueSchedulerService).tick(new Date(Date.now() + 1000));
    const row = (await ds.query(`SELECT status, attempts, last_error_code FROM task_queue WHERE id = $1`, [item.id]))[0];
    expect(row).toMatchObject({ attempts: 0, last_error_code: 'weekly_pace_exceeded' });
    expect(row.status).not.toBe('failed');
    expect(dispatched.filter((d) => d.machineId === m.machineId).length).toBe(before);

    await http().post('/v1/limits/pace-override').set(bearer(t.token)).send({}).expect(201);
    await ds.query(`UPDATE task_queue SET next_run_at = now() WHERE id = $1`, [item.id]);
    await svc(QueueSchedulerService).tick(new Date(Date.now() + 2000));
    expect(dispatched.filter((d) => d.machineId === m.machineId && d.type === 'command.dispatch').length).toBeGreaterThan(before);
  });
});

describe('ogohlantirish: kuniga har daraja bir marta', () => {
  it('soft (80%) bir marta, hard (100%) bir marta; qayta tikda yo\'q; sozlama o\'zgarsa bugungi ogohlantirishlar qayta hisoblanadi; taxmin deb belgilanadi', async () => {
    const m = await newMachine('zz-pace-alert');
    const t = await exemptToken();
    const w = svc(PaceWatcherService);
    const { midnight, resetsAt } = await seedWeek(m.machineId, 41);
    const allowance = 60 / ((resetsAt.getTime() - midnight.getTime()) / DAY);

    expect(await w.tick()).toBeNull(); // 1% ulush: hech narsa
    const now1 = new Date();
    await ds.query(`DELETE FROM limit_samples WHERE ts > $1`, [midnight]);
    await sample(m.machineId, new Date(now1.getTime() - 5_000), 40 + allowance * 0.85, resetsAt);
    expect(await w.tick()).toBe('soft');
    expect(await w.tick()).toBeNull();
    expect(telegramSent).toHaveLength(1);
    expect(telegramSent[0]).toContain('Haftalik limitning bugungi ulushi');
    expect(telegramSent[0]).toContain('Manba: rasmiy');
    expect(telegramSent[0]).toMatch(/angilanish/);
    expect((await ds.query(`SELECT level FROM pace_alerts ORDER BY level`)).map((r: { level: string }) => r.level)).toEqual(['soft']);
    expect((await getLimits((await issueToken(['read'])).token)).pace!.alertsToday.soft).not.toBeNull();

    await sample(m.machineId, new Date(Date.now() - 2_000), 40 + allowance * 1.05, resetsAt);
    expect(await w.tick()).toBe('hard');
    expect(await w.tick()).toBeNull();
    expect(telegramSent).toHaveLength(2);
    expect(telegramSent[1]).toContain('100%');
    expect((await ds.query(`SELECT level FROM pace_alerts ORDER BY level`)).map((r: { level: string }) => r.level)).toEqual(['hard', 'soft']);
    expect((await ds.query(`SELECT 1 FROM audit_log WHERE action = 'limits.pace_alert'`)).length).toBe(2);

    // sozlama o'zgarsa bugungi ogohlantirishlar qayta hisoblanadi
    await putSettings(t.token, { softPct: 50 }).expect(200);
    expect(await ds.query(`SELECT 1 FROM pace_alerts`)).toHaveLength(0);
    expect(await w.tick()).toBe('hard');
  });

  it("enabled=false: ogohlantirish yo'q", async () => {
    const m = await newMachine('zz-pace-alert-off');
    const t = await exemptToken();
    await seedWeek(m.machineId, 70);
    await putSettings(t.token, { enabled: false }).expect(200);
    expect(await svc(PaceWatcherService).tick()).toBeNull();
    expect(telegramSent).toHaveLength(0);
  });
});
