import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AlertDtoSchema, DEFAULT_WATCHDOG_SETTINGS, ListAlertsResponseSchema, ListReportsResponseSchema, ReportDtoSchema, WatchdogSettingsSchema } from '@commander/contracts';
import type { WatchdogSettings } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { ReportsDataService } from '../../src/reports/reports-data.service.js';
import { ReportsModule } from '../../src/reports/reports.module.js';
import { ReportsService } from '../../src/reports/reports.service.js';
import { periodFor } from '../../src/reports/report-logic.js';
import { WatchdogModule } from '../../src/watchdog/watchdog.module.js';
import { WatchdogService } from '../../src/watchdog/watchdog.service.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;
process.env['WATCHDOG_DISABLED'] = '1';
process.env['REPORTS_DISABLED'] = '1';

/** 3.2 watchdog + 3.3 hisobotlar: migratsiya cheklovlari, tick (haqiqiy DB), agregatsiya SQL, REST. Toshkent = UTC+5. */

let dbh: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let machineId: string;
let projectId: string;
const events: DomainEvent[] = [];
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const watchdog = (): WatchdogService => app.get(WatchdogService);

async function issue(scopes: string[]): Promise<string> {
  const t = await app.get(ClientTokensService).issue({ kind: 'web', name: `t-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return t.token;
}

let seq = 0;
async function mkSession(over: { status?: string; statusSince?: Date; project?: string | null } = {}): Promise<{ id: string; claude: string }> {
  const claude = `wd-${++seq}-${randomBytes(2).toString('hex')}`;
  const rows: Array<{ id: string }> = await ds.query(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, status, started_at, status_since, last_seen_at)
     VALUES ($1, $2, $3, '/w/commander', 'commander', $4, $5, $5, $5) RETURNING id`,
    [machineId, claude, over.project === undefined ? projectId : over.project, over.status ?? 'working', over.statusSince ?? new Date()],
  );
  return { id: rows[0]!.id, claude };
}
const alerts = (sessionId: string): Promise<Array<{ id: string; kind: string; state: string; reminders_sent: number; auto_stopped: boolean }>> =>
  ds.query(`SELECT id, kind, state, reminders_sent, auto_stopped FROM watchdog_alerts WHERE session_id = $1 ORDER BY created_at, kind`, [sessionId]);

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-x' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, ProjectsModule, AgentModule, RealtimeModule, CommandsModule,
      WatchdogModule, ReportsModule,
    ],
  })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(RealtimeBus).subscribe((e) => void events.push(e));
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ('wd-mac', 'wd') RETURNING id`);
  machineId = m!.id;
  const [p]: Array<{ id: string }> = await ds.query(`INSERT INTO projects (machine_id, path, name) VALUES ($1, '/w/commander', 'commander') RETURNING id`, [machineId]);
  projectId = p!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await dbh.drop();
});

describe('migratsiya cheklovlari', () => {
  it('bir sessiya + tur uchun bitta OCHIQ ogohlantirish; yopilgandan keyin yangisi mumkin; holat/resolved CHECK', async () => {
    const s = await mkSession();
    const ins = (kind = 'waiting') =>
      ds.query(`INSERT INTO watchdog_alerts (kind, session_id, machine_id, title) VALUES ($1, $2, $3, 't')`, [kind, s.id, machineId]);
    await ins();
    await expect(ins()).rejects.toThrow(/uq_watchdog_alerts_open/);
    await ins('burn'); // boshqa tur: mumkin
    await expect(ins('weird')).rejects.toThrow(/chk_watchdog_alerts_kind/);
    await ds.query(`UPDATE watchdog_alerts SET state = 'resolved', resolved_at = now() WHERE session_id = $1 AND kind = 'waiting'`, [s.id]);
    await ins();
    await expect(ds.query(`UPDATE watchdog_alerts SET state = 'resolved' WHERE session_id = $1 AND kind = 'burn'`, [s.id])).rejects.toThrow(/chk_watchdog_alerts_resolved/);
    await expect(ds.query(`INSERT INTO reports (kind, period_start, period_end, data) VALUES ('daily', '2026-01-02', '2026-01-01', '{}')`)).rejects.toThrow(/chk_reports_period/);
    await ds.query(`INSERT INTO reports (kind, period_start, period_end, data) VALUES ('daily', '2026-01-01', '2026-01-01', '{}')`);
    await expect(ds.query(`INSERT INTO reports (kind, period_start, period_end, data) VALUES ('daily', '2026-01-01', '2026-01-01', '{}')`)).rejects.toThrow(/uq_reports_kind_period/);
    await ds.query(`DELETE FROM reports`);
  });
});

describe('watchdog tick (haqiqiy DB, vaqt sayohati)', () => {
  const T = new Date('2026-11-13T10:00:00Z');
  const at = (min: number): Date => new Date(T.getTime() + min * 60_000);

  it('waiting: 15 daqiqada yaratadi (push + takror yo\'q), 1 soatda eslatma, holat o\'zgarsa yopadi', async () => {
    const s = await mkSession({ status: 'waiting', statusSince: T });
    events.length = 0;
    await watchdog().tick(at(14));
    expect(await alerts(s.id)).toHaveLength(0);
    await watchdog().tick(at(15));
    await watchdog().tick(at(16)); // takror yo'q
    const rows = await alerts(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'waiting', state: 'open', reminders_sent: 0 });
    const created = events.filter((e) => e.type === 'alert.changed' && e.created);
    expect(created).toHaveLength(1);
    expect(AlertDtoSchema.safeParse((created[0] as Extract<DomainEvent, { type: 'alert.changed' }>).alert).success).toBe(true);

    await watchdog().tick(at(15 + 61));
    expect((await alerts(s.id))[0]).toMatchObject({ reminders_sent: 1 });
    await watchdog().tick(at(15 + 62)); // yana eslatma emas (1 soat o'tmagan)
    expect((await alerts(s.id))[0]!.reminders_sent).toBe(1);

    await ds.query(`UPDATE sessions SET status = 'working', status_since = $2 WHERE id = $1`, [s.id, at(100)]);
    await watchdog().tick(at(101));
    expect((await alerts(s.id))[0]).toMatchObject({ state: 'resolved' });
    await watchdog().tick(at(300)); // epizod tugagan: qayta ochilmaydi
    expect(await alerts(s.id)).toHaveLength(1);
  });

  it('burn: 10 daqiqadagi vaznli token chegaradan oshsa; eski tokenlar hisoblanmaydi; tushganda yopiladi', async () => {
    const s = await mkSession({ status: 'working' });
    const usage = (ts: Date, out: number): Promise<unknown> =>
      ds.query(
        `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source)
         VALUES ($1, $2, $3, $4, $5, 'claude-opus-4-7', 0, $6, 0, 0, 'otel')`,
        [ts, machineId, `r-${randomBytes(4).toString('hex')}`, s.claude, projectId, out],
      );
    await usage(at(-30), 2_000_000); // 10M vaznli, lekin oynadan tashqari
    await watchdog().tick(T);
    expect(await alerts(s.id)).toHaveLength(0);
    await usage(at(-5), 900_000); // 4.5M
    await watchdog().tick(T);
    expect(await alerts(s.id)).toHaveLength(0);
    await usage(at(-2), 200_000); // +1M => 5.5M
    await watchdog().tick(T);
    const [a] = await alerts(s.id);
    expect(a).toMatchObject({ kind: 'burn', state: 'open', auto_stopped: false });
    const detail = await watchdog().getDto(a!.id);
    expect(detail.metrics['weighted10m']).toBe(5_500_000);
    expect(detail.detail).toContain('5.5M');
    await watchdog().tick(at(30)); // tokenlar oynadan chiqdi
    expect((await alerts(s.id))[0]!.state).toBe('resolved');
  });

  it('error_loop: agentd belgisi (>= 5) -> ogohlantirish; matn saqlanmaydi; avto-stop yoqilgan loyihada buyruq + audit', async () => {
    const s = await mkSession({ status: 'working' });
    const settings: WatchdogSettings = { ...DEFAULT_WATCHDOG_SETTINGS, projects: { [projectId]: { autoStop: true } } };
    await watchdog().putSettings(settings);
    const ev = (count: number, ts: Date): Promise<unknown> =>
      ds.query(`INSERT INTO session_events (ts, session_id, machine_id, event, status, message, notification_type) VALUES ($1, $2, $3, 'ErrorLoop', 'working', $4, 'error_loop')`, [ts, s.id, machineId, `error_loop:abcdef012345:${count}`]);
    await ev(5, at(-1));
    await ds.query(`INSERT INTO session_events (ts, session_id, machine_id, event, status, message, notification_type) VALUES ($1, $2, $3, 'ErrorLoop', 'working', 'oddiy matn', 'error_loop')`, [at(-1), s.id, machineId]); // noto'g'ri format: e'tiborsiz
    await watchdog().tick(T);
    const [a] = await alerts(s.id);
    expect(a).toMatchObject({ kind: 'error_loop', state: 'open' });
    const dto = await watchdog().getDto(a!.id);
    expect(dto.metrics).toMatchObject({ hash: 'abcdef012345', count: 5 });
    expect(JSON.stringify(dto)).not.toContain('oddiy matn');

    // avto-stop: mashina offline => buyruq `rejected`, lekin yaratilgan va audit qilingan
    const cmds: Array<{ type: string; status: string; dev: string }> = await ds.query(`SELECT type, status, requested_by_device_id AS dev FROM commands WHERE session_id = $1`, [s.id]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: 'session.stop' });
    const dev: Array<{ kind: string; external_id: string; token_hash: string | null }> = await ds.query(`SELECT kind, external_id, token_hash FROM devices WHERE id = $1`, [cmds[0]!.dev]);
    expect(dev[0]).toMatchObject({ kind: 'web', external_id: 'watchdog', token_hash: null });
    const audit = await ds.query(`SELECT actor_kind FROM audit_log WHERE action = 'watchdog.auto_stop' AND target = $1`, [s.id]);
    expect(audit).toEqual([{ actor_kind: 'system' }]);
    await watchdog().putSettings(DEFAULT_WATCHDOG_SETTINGS);
  });

  it('watchdog o\'chirilsa: ochiq ogohlantirishlar yopiladi, yangisi yo\'q', async () => {
    const s = await mkSession({ status: 'waiting', statusSince: at(-60) });
    await watchdog().tick(T);
    expect((await alerts(s.id))[0]!.state).toBe('open');
    await watchdog().putSettings({ ...DEFAULT_WATCHDOG_SETTINGS, enabled: false });
    await watchdog().tick(at(1));
    expect((await alerts(s.id))[0]!.state).toBe('resolved');
    await watchdog().putSettings(DEFAULT_WATCHDOG_SETTINGS);
  });
});

describe('REST: /v1/alerts, /v1/watchdog/settings', () => {
  it('auth, ro\'yxat, rad etish (control), sozlamalar validatsiyasi', async () => {
    await http().get('/v1/alerts').expect(401);
    const reader = await issue(['read']);
    const ctl = await issue(['read', 'control']);
    const s = await mkSession({ status: 'waiting', statusSince: new Date(Date.now() - 3_600_000) });
    await watchdog().tick(new Date());
    const list = ListAlertsResponseSchema.parse((await http().get('/v1/alerts?state=open').set(bearer(reader)).expect(200)).body.data ?? (await http().get('/v1/alerts?state=open').set(bearer(reader))).body);
    const mine = list.items.find((a) => a.sessionId === s.id);
    expect(mine).toMatchObject({ kind: 'waiting', state: 'open', projectName: 'commander' });
    await http().post(`/v1/alerts/${mine!.id}/dismiss`).set(bearer(reader)).expect(403);
    const dis = (await http().post(`/v1/alerts/${mine!.id}/dismiss`).set(bearer(ctl)).expect(200)).body;
    expect(AlertDtoSchema.parse(dis.data ?? dis).state).toBe('dismissed');
    await http().post('/v1/alerts/not-a-uuid/dismiss').set(bearer(ctl)).expect(400);
    await http().post('/v1/alerts/11111111-1111-4111-8111-111111111111/dismiss').set(bearer(ctl)).expect(404);
    await watchdog().tick(new Date(Date.now() + 5_000_000)); // rad etilgan epizod qayta ochilmaydi
    expect((await alerts(s.id)).map((r) => r.state)).toEqual(['dismissed']);

    await http().put('/v1/watchdog/settings').set(bearer(reader)).send(DEFAULT_WATCHDOG_SETTINGS).expect(403);
    const bad = { ...DEFAULT_WATCHDOG_SETTINGS, defaults: { ...DEFAULT_WATCHDOG_SETTINGS.defaults, waitingMinutes: 0 } };
    await http().put('/v1/watchdog/settings').set(bearer(ctl)).send(bad).expect(400);
    const next: WatchdogSettings = { ...DEFAULT_WATCHDOG_SETTINGS, defaults: { ...DEFAULT_WATCHDOG_SETTINGS.defaults, waitingMinutes: 30 }, sessions: { [s.id]: { autoStop: true } } };
    await http().put('/v1/watchdog/settings').set(bearer(ctl)).send(next).expect(200);
    const got = (await http().get('/v1/watchdog/settings').set(bearer(reader)).expect(200)).body;
    expect(WatchdogSettingsSchema.parse(got.data ?? got)).toEqual(next);
    await watchdog().putSettings(DEFAULT_WATCHDOG_SETTINGS);
  });
});

describe('hisobot agregatsiyasi (SQL) va arxiv', () => {
  // Toshkent kuni 2026-11-20 = [2026-11-19T19:00Z, 2026-11-20T19:00Z)
  const DAY = '2026-11-20';
  const NOW = new Date('2026-11-20T17:00:00Z'); // Toshkent 22:00
  const t = (hhmmUtc: string): Date => new Date(`2026-11-20T${hhmmUtc}:00Z`);
  let p2: string;
  let sOpus: { id: string; claude: string };

  beforeAll(async () => {
    const [pp]: Array<{ id: string }> = await ds.query(`INSERT INTO projects (machine_id, path, name) VALUES ($1, '/w/iot', 'iot') RETURNING id`, [machineId]);
    p2 = pp!.id;
    sOpus = await mkSession({ status: 'working', statusSince: t('05:00') });
    const sSon = await mkSession({ status: 'working', statusSince: t('05:00'), project: p2 });
    const use = (ts: Date, s: { claude: string }, proj: string, model: string, input: number, output: number, cost: number | null): Promise<unknown> =>
      ds.query(
        `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, 'otel')`,
        [ts, machineId, `rep-${randomBytes(4).toString('hex')}`, s.claude, proj, model, input, output, cost],
      );
    // commander: Opus, kichik vazifa "3.4" (S = 2 soat) span ichida: 100 so'rov, 100k input + 60k output => vaznli 400k
    await ds.query(`INSERT INTO project_tasks (project_id, task_key, title, status, "order", size) VALUES ($1, '3.4', 'Shablonlar', 'done', 1, 'S')`, [projectId]);
    await ds.query(`INSERT INTO session_task_spans (machine_id, session_id, project_id, task_key, source, started_at) VALUES ($1, $2, $3, '3.4', 'explicit', $4)`, [machineId, sOpus.claude, projectId, t('06:00')]);
    for (let i = 0; i < 20; i++) await use(t('07:00'), sOpus, projectId, 'claude-opus-4-7', 5000, 3000, 0.5); // 20 * (5000 + 15000) = 400k
    await use(t('08:00'), sSon, p2, 'claude-sonnet-5-5', 1000, 0, null);
    // oyna tashqarisi (oldingi kun, keyingi kun): hisoblanmaydi
    await use(new Date('2026-11-19T18:00:00Z'), sOpus, projectId, 'claude-opus-4-7', 9_000_000, 0, 99);
    await use(new Date('2026-11-20T19:30:00Z'), sOpus, projectId, 'claude-opus-4-7', 9_000_000, 0, 99);
    // yopilgan vazifa, commitlar
    await ds.query(`INSERT INTO task_events (project_id, task_key, from_status, to_status, source, ts) VALUES ($1, '3.4', 'doing', 'done', 'tasks_md', $2)`, [projectId, t('09:00')]);
    await ds.query(`INSERT INTO task_events (project_id, task_key, from_status, to_status, source, ts) VALUES ($1, '3.3', 'doing', 'done', 'tasks_md', $2)`, [projectId, new Date('2026-11-19T10:00:00Z')]); // kecha
    const commits = [
      { sha: 'a'.repeat(40), subject: 's', author: 'x', ts: t('09:30').getTime() },
      { sha: 'b'.repeat(40), subject: 's', author: 'x', ts: t('10:30').getTime() },
      { sha: 'c'.repeat(40), subject: 'eski', author: 'x', ts: new Date('2026-11-17T10:00:00Z').getTime() },
    ];
    await ds.query(`INSERT INTO project_snapshots (project_id, hash, commits) VALUES ($1, 'h1', $2::jsonb)`, [projectId, JSON.stringify(commits)]);
    await ds.query(`INSERT INTO project_snapshots (project_id, hash, commits) VALUES ($1, 'h2', $2::jsonb)`, [projectId, JSON.stringify(commits.slice(0, 2))]); // dublikat sha: bir marta
    // faol vaqt: working 06:00 -> 07:30 (1.5 soat), keyin idle
    const sev = (ts: Date, status: string): Promise<unknown> => ds.query(`INSERT INTO session_events (ts, session_id, machine_id, event, status) VALUES ($1, $2, $3, 'x', $4)`, [ts, sOpus.id, machineId, status]);
    await sev(t('06:00'), 'working');
    await sev(t('07:30'), 'idle');
    await ds.query(`INSERT INTO daily_summaries (project_id, day, summary, model) VALUES ($1, $2, 'Shablonlar tayyor', 'sonnet')`, [projectId, DAY]);
  });

  it('kunlik: tokenlar, narx, yopilgan vazifa, commit (dublikatsiz), faol vaqt, sessiyalar, top vazifa, reja/haqiqiy, xulosa', async () => {
    const data = await app.get(ReportsDataService).build(periodFor('daily', DAY), NOW);
    expect(data.total.tokens).toMatchObject({ input: 100_000 + 1000, output: 60_000 });
    expect(data.total.tokens.weighted).toBe(401_000);
    expect(data.total.costUsd).toBe(10);
    expect(data.total.commits).toBe(2);
    expect(data.total.tasksClosed).toEqual([{ key: '3.4', title: 'Shablonlar' }]);
    const c = data.projects.find((p) => p.name === 'commander')!;
    expect(c).toMatchObject({ commits: 2, sessions: 1, activeSeconds: 5400 });
    expect(c.tokens.weighted).toBe(400_000);
    expect(c.limitShare).toBeCloseTo(0.998, 3);
    expect(c.topTasks).toEqual([{ key: '3.4', title: 'Shablonlar', weighted: 400_000, costUsd: 10 }]);
    expect(c.planVsActual).toMatchObject({ plannedHours: 2, tasks: 1 });
    expect(c.summaries).toEqual(['Shablonlar tayyor']);
    expect(c.models).toEqual([expect.objectContaining({ model: 'Opus', requests: 20, share: 1 })]);
    const iot = data.projects.find((p) => p.name === 'iot')!;
    expect(iot).toMatchObject({ sessions: 1, costUsd: null });
    // tavsiya R1: kichik vazifa Opus'da (400k, 100%)
    expect(data.recommendations.some((r) => r.includes('«3.4»'))).toBe(true);
  });

  it('haftalik davr kecha ham o\'z ichiga oladi (yopilgan 3.3, 9M tokenlar)', async () => {
    const data = await app.get(ReportsDataService).build(periodFor('weekly', DAY), NOW);
    expect(data.total.tasksClosed.map((x) => x.key).sort()).toEqual(['3.3', '3.4']);
    expect(data.total.tokens.weighted).toBeGreaterThan(9_000_000);
  });

  it('bo\'sh kun: nol, xatosiz', async () => {
    const data = await app.get(ReportsDataService).build(periodFor('daily', '2026-01-05'), NOW);
    expect(data.projects).toEqual([]);
    expect(data.total).toMatchObject({ commits: 0, sessions: 0, costUsd: null });
  });

  it('REST: generate (control) -> arxiv (read) -> ko\'rish; qayta yaratish yangilaydi; sozlamalar', async () => {
    const reader = await issue(['read']);
    const ctl = await issue(['read', 'control']);
    await http().post('/v1/reports/generate').set(bearer(reader)).send({ kind: 'daily', day: DAY }).expect(403);
    await http().post('/v1/reports/generate').set(bearer(ctl)).send({ kind: 'monthly' }).expect(400);
    const gen = (await http().post('/v1/reports/generate').set(bearer(ctl)).send({ kind: 'daily', day: DAY }).expect(200)).body;
    const dto = ReportDtoSchema.parse(gen);
    expect(dto).toMatchObject({ kind: 'daily', periodStart: DAY, periodEnd: DAY, sentAt: null });
    expect(dto.textHtml).toContain('Kunlik hisobot');
    await http().post('/v1/reports/generate').set(bearer(ctl)).send({ kind: 'daily', day: DAY }).expect(200);
    const list = ListReportsResponseSchema.parse(((await http().get('/v1/reports?kind=daily').set(bearer(reader)).expect(200)).body as { data?: unknown }).data ?? (await http().get('/v1/reports?kind=daily').set(bearer(reader))).body);
    expect(list.items.filter((i) => i.periodStart === DAY)).toHaveLength(1); // UNIQUE: yangilandi
    const got = (await http().get(`/v1/reports/${dto.id}`).set(bearer(reader)).expect(200)).body;
    expect(ReportDtoSchema.parse(got).id).toBe(dto.id);
    await http().get('/v1/reports/11111111-1111-4111-8111-111111111111').set(bearer(reader)).expect(404);

    const st = { dailyEnabled: true, weeklyEnabled: false, dailyTime: '22:30', weeklyTime: '20:00', weeklyDay: 0 };
    await http().put('/v1/reports/settings').set(bearer(ctl)).send({ ...st, dailyTime: '25:00' }).expect(400);
    await http().put('/v1/reports/settings').set(bearer(ctl)).send(st).expect(200);
    const gotSt = (await http().get('/v1/reports/settings').set(bearer(reader)).expect(200)).body;
    expect(gotSt.data ?? gotSt).toEqual(st);
  });

  it('jadval tick: vaqti kelganda bir marta yaratadi (Telegram o\'chiq: sent_at null), qayta yaratmaydi', async () => {
    await ds.query(`DELETE FROM reports`);
    await app.get(ReportsService).putSettings({ dailyEnabled: true, weeklyEnabled: true, dailyTime: '21:00', weeklyTime: '20:00', weeklyDay: 0 });
    const early = new Date('2026-11-20T15:59:00Z'); // 20:59 Toshkent
    expect(await app.get(ReportsService).tick(early)).toEqual([]);
    const due = await app.get(ReportsService).tick(new Date('2026-11-20T16:00:00Z'));
    expect(due.map((p) => p.kind)).toEqual(['daily']); // 20-noy juma
    expect(await app.get(ReportsService).tick(new Date('2026-11-20T17:30:00Z'))).toEqual([]);
    const rows: Array<{ kind: string; sent_at: Date | null }> = await ds.query(`SELECT kind, sent_at FROM reports`);
    expect(rows).toEqual([{ kind: 'daily', sent_at: null }]);
    // yakshanba 22-noy 20:00 dan keyin: haftalik + kunlik
    const sun = await app.get(ReportsService).tick(new Date('2026-11-22T16:30:00Z')); // 21:30 Toshkent
    expect(sun.map((p) => p.kind).sort()).toEqual(['daily', 'weekly']);
  });

  it('/report jonli (saqlanmaydi) va AlertDto tiplari', async () => {
    const before = (await ds.query(`SELECT count(*)::int AS n FROM reports`))[0].n as number;
    const parts = await app.get(ReportsService).liveReport('week');
    expect(parts[0]).toContain('Haftalik hisobot');
    expect((await ds.query(`SELECT count(*)::int AS n FROM reports`))[0].n).toBe(before);
  });
});
