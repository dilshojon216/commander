import { createHash, randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ClientDtoSchema, ClientReportPreviewSchema, CreateClientReportResponseSchema, ExportFileSchema, ListBillingProjectsResponseSchema, ListClientReportSnapshotsResponseSchema, TimesheetDtoSchema } from '@commander/contracts';
import type { TimesheetDto } from '@commander/contracts';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { BillingModule } from '../../src/billing/billing.module.js';
import { CommandsModule } from '../../src/commands/commands.module.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { ProjectsModule } from '../../src/projects/projects.module.js';
import { addDays, tashkentDayOf, tashkentDayStart } from '../../src/projects/tashkent-day.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;
process.env['WATCHDOG_DISABLED'] = '1';
process.env['REPORTS_DISABLED'] = '1';

/** 6.7 timesheet + 6.8 mijoz hisoboti: migratsiya cheklovlari, REST, haqiqiy SQL (parallel sessiyalar, mashinalar bo'ylab repo_key), eksport, sizib chiqmasligi. */

const H = 3_600_000;
let dbh: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let readTok: string;
let ctlTok: string;
const http = () => request(app.getHttpServer());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const today = tashkentDayOf(new Date());
const day = (back: number): string => addDays(today, -back);
const t0 = tashkentDayStart(day(5)).getTime(); // 5 kun oldingi Toshkent yarim kechasi (UTC instant)
const at = (h: number): Date => new Date(t0 + h * H);

const SHA = '9fceb02d0ae598e95dc970b74767f19372d61af8';
let pa: string;
let pb: string;
let pc: string;
let clientId: string;

async function issue(scopes: string[]): Promise<string> {
  const t = await app.get(ClientTokensService).issue({ kind: 'web', name: `t-${randomBytes(2).toString('hex')}`, scopes }, 'test');
  return t.token;
}
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => ((await ds.query(sql, params)) as T[])[0]!;

async function ev(session: string, machine: string, h: number, status: string): Promise<void> {
  await ds.query(`INSERT INTO session_events (ts, session_id, machine_id, event, status) VALUES ($1, $2, $3, 'X', $4)`, [at(h), session, machine, status]);
}
async function mkSession(machine: string, project: string, claude: string): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO sessions (machine_id, claude_session_id, project_id, cwd, project, status, started_at, status_since, last_seen_at) VALUES ($1, $2, $3, '/w', 'w', 'idle', $4, $4, $4) RETURNING id`,
    [machine, claude, project, at(0)],
  );
  return r.id;
}

beforeAll(async () => {
  dbh = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy-x' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(dbh.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, ProjectsModule, AgentModule, RealtimeModule, CommandsModule, BillingModule,
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
  readTok = await issue(['read']);
  ctlTok = await issue(['read', 'control']);

  const mA = await one<{ id: string }>(`INSERT INTO machines (slug, hostname, display_name) VALUES ('wd-mac', 'wd', 'Alex MacBook') RETURNING id`);
  const mB = await one<{ id: string }>(`INSERT INTO machines (slug, hostname) VALUES ('wd-ubuntu', 'wdu') RETURNING id`);
  const proj = async (m: string, path: string, name: string, repo: string | null): Promise<string> =>
    (await one<{ id: string }>(`INSERT INTO projects (machine_id, path, name, repo_key) VALUES ($1, $2, $3, $4) RETURNING id`, [m, path, name, repo])).id;
  pa = await proj(mA.id, '/Users/x/work/proj-a', 'proj-a', 'github.com/acme/app');
  pb = await proj(mB.id, '/home/y/proj-a', 'proj-a', 'github.com/acme/app');
  pc = await proj(mA.id, '/Users/x/work/other', 'other', 'github.com/acme/other');
  await proj(mA.id, '/Users/x/work/solo', 'solo', 'github.com/zzz/solo');

  const sA = await mkSession(mA.id, pa, 'cs-a');
  const sB = await mkSession(mB.id, pb, 'cs-b');
  const sC = await mkSession(mA.id, pc, 'cs-c');
  // app: sA 1..3, sB 2..4 (parallel, mashinalar bo'ylab) -> birlashma 3 soat; other: sC 1..2
  await ev(sA, mA.id, 1, 'working'); await ev(sA, mA.id, 3, 'idle');
  await ev(sB, mB.id, 2, 'awaiting_approval'); await ev(sB, mB.id, 4, 'idle');
  await ev(sC, mA.id, 1, 'working'); await ev(sC, mA.id, 2, 'idle');
  await ds.query(`INSERT INTO session_task_spans (machine_id, session_id, project_id, task_key, source, started_at) VALUES ($1, 'cs-a', $2, '6.7', 'explicit', $3)`, [mA.id, pa, at(0)]);
  for (const [i, ts] of [at(1.5), at(2.5)].entries()) {
    await ds.query(
      `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
       VALUES ($1, $2, $3, 'cs-a', $4, 'claude-opus-4-7', 100, 50, 0, 0, 0.5, 'otel')`,
      [ts, mA.id, `rq-${i}`, pa],
    );
  }
  const task = (p: string, key: string, title: string, status: string, order: number, size: string | null, upd: Date): Promise<unknown> =>
    ds.query(`INSERT INTO project_tasks (project_id, task_key, title, status, "order", size, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [p, key, title, status, order, size, upd]);
  await task(pa, '6.7', 'Timesheet va hisobot', 'doing', 1, 'S', new Date());
  await task(pa, '6.8', 'Mijoz sahifasi /Users/x/work/proj-a/src/a.ts', 'todo', 2, 'M', new Date());
  await task(pa, '6.1', `Tayyor ish ${SHA.slice(0, 9)} wd-ubuntu da`, 'done', 0, null, new Date());
  await task(pb, '6.7', 'ESKI NOM (boshqa mashina)', 'todo', 1, 'S', new Date(Date.now() - 86_400_000));
  await ds.query(`INSERT INTO task_events (project_id, task_key, from_status, to_status, source, ts) VALUES ($1, '6.1', 'doing', 'done', 'tasks_md', $2)`, [pa, at(5)]);
  await ds.query(`INSERT INTO project_snapshots (project_id, hash, commits) VALUES ($1, 'h1', $2::jsonb)`, [pa, JSON.stringify([{ sha: SHA, ts: at(3).getTime(), subject: 'feat: x', author: 'A' }, { sha: 'a'.repeat(40), ts: at(3.5).getTime(), subject: 'fix', author: 'A' }])]);
  await ds.query(`INSERT INTO task_commits (project_id, sha, task_key, source, committed_at) VALUES ($1, $2, '6.7', 'subject', $3)`, [pa, SHA, at(3)]);
  await ds.query(`INSERT INTO daily_summaries (project_id, day, summary, model) VALUES ($1, $2, $3, 'm')`, [pa, day(5), `- Login tugadi (src/login.tsx)\n- Server wd-mac dan ko'chirildi\n- API_KEY=sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZ ishlatildi\n- commit ${SHA}`]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await dbh.drop();
});

describe('migratsiya cheklovlari', () => {
  it('mijoz nomi katta-kichik harfsiz UNIQUE, stavka/valyuta CHECK, project_key bitta mijozda', async () => {
    const c = await one<{ id: string }>(`INSERT INTO clients (name, hourly_rate, currency) VALUES ('Zeta', 12.5, 'USD') RETURNING id`);
    await expect(ds.query(`INSERT INTO clients (name) VALUES ('zETA')`)).rejects.toThrow(/uq_clients_name/);
    await expect(ds.query(`INSERT INTO clients (name, currency) VALUES ('Y', 'EUR')`)).rejects.toThrow(/chk_clients_currency/);
    await expect(ds.query(`INSERT INTO clients (name, hourly_rate) VALUES ('Y', -1)`)).rejects.toThrow(/chk_clients_rate/);
    await expect(ds.query(`INSERT INTO clients (name) VALUES ('')`)).rejects.toThrow(/chk_clients_name/);
    const c2 = await one<{ id: string }>(`INSERT INTO clients (name) VALUES ('Eta') RETURNING id`);
    await ds.query(`INSERT INTO client_projects (project_key, client_id) VALUES ('k1', $1)`, [c.id]);
    await expect(ds.query(`INSERT INTO client_projects (project_key, client_id) VALUES ('k1', $1)`, [c2.id])).rejects.toThrow(/pk_client_projects/);
    await ds.query(`DELETE FROM clients WHERE id = $1`, [c.id]); // cascade
    expect(await ds.query(`SELECT 1 FROM client_projects WHERE project_key = 'k1'`)).toHaveLength(0);
    await ds.query(`DELETE FROM clients WHERE id = $1`, [c2.id]);
  });

  it('snapshot jurnali append-only: faqat telegram_sent_at o\'zgaradi; DELETE/TRUNCATE bloklangan', async () => {
    const sha = 'a'.repeat(64);
    const r = await one<{ id: string }>(
      `INSERT INTO client_report_snapshots (actor_kind, client_name, project_keys, period_from, period_to, html_sha256, pdf_sha256, html_bytes, pdf_bytes)
       VALUES ('web', 'X', '{k}', '2026-01-01', '2026-01-02', $1, $1, 1, 1) RETURNING id`,
      [sha],
    );
    await ds.query(`UPDATE client_report_snapshots SET telegram_sent_at = now() WHERE id = $1`, [r.id]);
    await expect(ds.query(`UPDATE client_report_snapshots SET html_sha256 = $2 WHERE id = $1`, [r.id, 'b'.repeat(64)])).rejects.toThrow(/append-only/);
    await expect(ds.query(`UPDATE client_report_snapshots SET client_name = 'Y' WHERE id = $1`, [r.id])).rejects.toThrow(/append-only/);
    await expect(ds.query(`DELETE FROM client_report_snapshots WHERE id = $1`, [r.id])).rejects.toThrow(/append-only/);
    await expect(ds.query(`TRUNCATE client_report_snapshots`)).rejects.toThrow(/append-only/);
    await expect(ds.query(`INSERT INTO client_report_snapshots (actor_kind, client_name, project_keys, period_from, period_to, html_sha256, pdf_sha256, html_bytes, pdf_bytes) VALUES ('web','X','{k}','2026-01-01','2026-01-02','zz','zz',1,1)`)).rejects.toThrow(/chk_client_report_snapshots_sha/);
  });
});

describe('mijozlar REST', () => {
  it("autentifikatsiyasiz 401; read tokeni yoza olmaydi (403); control yaratadi; takror nom 409", async () => {
    await http().get('/v1/billing/clients').expect(401);
    await http().post('/v1/billing/clients').set(auth(readTok)).send({ name: 'Acme' }).expect(403);
    const res = await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'Acme', notes: 'Muhim mijoz', hourlyRate: '10', currency: 'USD' }).expect(201);
    expect(ClientDtoSchema.safeParse(res.body).success).toBe(true);
    clientId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Acme', hourlyRate: '10', currency: 'USD', projectKeys: [] });
    await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'acme' }).expect(409);
    await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'X', hourlyRate: '-5' }).expect(400);
    await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'X', hourlyRate: '1e3' }).expect(400);
    await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'X', evil: 1 }).expect(400);
  });

  it("loyiha guruhi: mashinalar bo'ylab bitta (repo_key); bog'lash, ko'chirish, noma'lum kalit 400", async () => {
    const list = await http().get('/v1/billing/projects').set(auth(readTok)).expect(200);
    expect(ListBillingProjectsResponseSchema.safeParse(list.body).success).toBe(true);
    const app1 = list.body.items.find((p: { projectKey: string }) => p.projectKey === 'github.com/acme/app');
    expect(app1).toMatchObject({ machines: 2, clientId: null, name: 'proj-a' });
    expect(list.body.items).toHaveLength(3);

    await http().put(`/v1/billing/clients/${clientId}/projects`).set(auth(readTok)).send({ projectKeys: [] }).expect(403);
    await http().put(`/v1/billing/clients/${clientId}/projects`).set(auth(ctlTok)).send({ projectKeys: ['nope'] }).expect(400);
    const set = await http().put(`/v1/billing/clients/${clientId}/projects`).set(auth(ctlTok)).send({ projectKeys: ['github.com/acme/app', 'github.com/acme/other'] }).expect(200);
    expect(set.body.projectKeys).toEqual(['github.com/acme/app', 'github.com/acme/other']);

    const other = await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'Beta' }).expect(201);
    await http().put(`/v1/billing/clients/${other.body.id}/projects`).set(auth(ctlTok)).send({ projectKeys: ['github.com/acme/other'] }).expect(200); // ko'chadi
    expect((await http().get('/v1/billing/clients').set(auth(readTok))).body.items.find((c: { name: string }) => c.name === 'Acme').projectKeys).toEqual(['github.com/acme/app']);
    await http().put(`/v1/billing/clients/${other.body.id}/projects`).set(auth(ctlTok)).send({ projectKeys: [] }).expect(200);
    // qayta Acme'ga
    await http().put(`/v1/billing/clients/${clientId}/projects`).set(auth(ctlTok)).send({ projectKeys: ['github.com/acme/app', 'github.com/acme/other'] }).expect(200);
    await http().delete(`/v1/billing/clients/${other.body.id}`).set(auth(ctlTok)).expect(200);
    await http().delete(`/v1/billing/clients/${other.body.id}`).set(auth(ctlTok)).expect(404);
    const upd = await http().patch(`/v1/billing/clients/${clientId}`).set(auth(ctlTok)).send({ notes: 'Yangilandi', hourlyRate: null }).expect(200);
    expect(upd.body).toMatchObject({ notes: 'Yangilandi', hourlyRate: null });
    await http().patch(`/v1/billing/clients/${clientId}`).set(auth(ctlTok)).send({ hourlyRate: '10.50' }).expect(200);
    await http().patch(`/v1/billing/clients/${clientId}`).set(auth(ctlTok)).send({}).expect(400);
  });

  it('CRUD amallari audit_log da', async () => {
    const rows: Array<{ action: string }> = await ds.query(`SELECT DISTINCT action FROM audit_log WHERE action LIKE '%/v1/billing/%' ORDER BY 1`);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['POST /v1/billing/clients', 'PUT /v1/billing/clients/:id/projects', 'PATCH /v1/billing/clients/:id', 'DELETE /v1/billing/clients/:id']));
  });
});

describe('timesheet (haqiqiy SQL)', () => {
  const q = (extra = ''): string => `from=${day(6)}&to=${day(2)}${extra}`;
  let dto: TimesheetDto;

  it('parallel sessiyalar (turli mashina, bitta repo_key) ikki marta sanalmaydi; mijoz jami = birlashma', async () => {
    const res = await http().get(`/v1/billing/timesheet?${q()}`).set(auth(readTok)).expect(200);
    expect(TimesheetDtoSchema.safeParse(res.body).success).toBe(true);
    dto = res.body as TimesheetDto;
    const acme = dto.clients.find((c) => c.name === 'Acme')!;
    const app1 = acme.projects.find((p) => p.projectKey === 'github.com/acme/app')!;
    const other = acme.projects.find((p) => p.projectKey === 'github.com/acme/other')!;
    expect(app1.totals.activeSeconds).toBe(3 * 3600); // 1..4 soat birlashma (sA 1..3 + sB 2..4)
    expect(other.totals.activeSeconds).toBe(3600);
    expect(acme.totals.activeSeconds).toBe(3 * 3600); // 1..4 soat: other (1..2) app ichida
    expect(acme.overlapSeconds).toBe(3600);
    expect(acme.totals.sessions).toBe(3);
    expect(dto.clients.map((c) => c.name)).not.toContain('solo');
  });

  it('summa (daqiqa x stavka), vazifa hisobi, yopilgan, commitlar, reja vs haqiqiy', () => {
    const acme = dto.clients.find((c) => c.name === 'Acme')!;
    expect(acme.billedMinutes).toBe(180);
    expect(acme.hourlyRate).toBe('10.5');
    expect(acme.amount).toBe('31.50');
    expect(acme.amountCurrency).toBe('USD');
    const app1 = acme.projects.find((p) => p.projectKey === 'github.com/acme/app')!;
    const t67 = app1.tasks.find((t) => t.key === '6.7')!;
    expect(t67).toMatchObject({ title: 'Timesheet va hisobot', activeSeconds: 2 * 3600, sessions: 1, plannedHours: 2, commits: 1 });
    expect(t67.tokens).toMatchObject({ input: 200, output: 100 });
    expect(t67.costUsd).toBe(1);
    expect(app1.unattributedSeconds).toBe(3600);
    expect(app1.totals.tasksClosed).toBe(1);
    expect(app1.tasks.find((t) => t.key === '6.1')).toMatchObject({ closedInPeriod: true, title: expect.stringContaining('Tayyor ish') });
    expect(app1.totals.commits).toBe(2); // ikki xesh (snapshot + task_commits dublikatsiz)
    expect(app1.totals.plannedSeconds).toBe(7200);
    expect(app1.totals.plannedActualSeconds).toBe(7200);
    // mashinalar bo'ylab dublikat vazifa: yangi satr tanlangan
    expect(JSON.stringify(dto)).not.toContain('ESKI NOM');
  });

  it("loyiha tokenlari kunlik agregatdan (30 kun ichida realtime): jami to'g'ri", () => {
    const app1 = dto.clients.find((c) => c.name === 'Acme')!.projects.find((p) => p.projectKey === 'github.com/acme/app')!;
    expect(app1.totals.tokens).toMatchObject({ input: 200, output: 100 });
    expect(app1.totals.costUsd).toBe(1);
    expect(dto.taskTokensPartial).toBe(false);
  });

  it("valyuta: UZS ko'rsatish kurs talab qiladi; kurs bilan o'giriladi", async () => {
    const noFx = await http().get(`/v1/billing/timesheet?${q('&currency=UZS')}`).set(auth(readTok)).expect(200);
    expect(noFx.body.clients.find((c: { name: string }) => c.name === 'Acme')).toMatchObject({ amount: null, amountNote: expect.stringContaining('Kurs') });
    const fx = await http().get(`/v1/billing/timesheet?${q('&currency=UZS&fxUzsPerUsd=12600.5')}`).set(auth(readTok)).expect(200);
    expect(fx.body.clients.find((c: { name: string }) => c.name === 'Acme')).toMatchObject({ amount: '396916', amountCurrency: 'UZS' }); // 31.50 * 12600.5 = 396915.75
  });

  it('mijoz filtri va davr tekshiruvlari', async () => {
    const only = await http().get(`/v1/billing/timesheet?${q(`&clientId=${clientId}`)}`).set(auth(readTok)).expect(200);
    expect(only.body.clients).toHaveLength(1);
    expect(only.body.total.activeSeconds).toBe(3 * 3600);
    await http().get('/v1/billing/timesheet?from=2026-02-30&to=2026-03-01').set(auth(readTok)).expect(400);
    await http().get(`/v1/billing/timesheet?from=${day(2)}&to=${day(6)}`).set(auth(readTok)).expect(400);
    await http().get('/v1/billing/timesheet?from=2020-01-01&to=2026-01-01').set(auth(readTok)).expect(400);
    await http().get('/v1/billing/timesheet').set(auth(readTok)).expect(400);
    await http().get(`/v1/billing/timesheet?month=2026-11&from=${day(2)}&to=${day(1)}`).set(auth(readTok)).expect(400);
    await http().get('/v1/billing/timesheet?month=2026-11').set(auth(readTok)).expect(200);
  });

  it("oy/kun chegarasi: Toshkent yarim kechasi (UTC 19:00) o'tgan oraliq kesiladi", async () => {
    const m = await one<{ id: string }>(`SELECT id FROM machines WHERE slug = 'wd-mac'`);
    const s = await mkSession(m.id, pc, 'cs-edge');
    // day(8): 23:00..day(7) 02:00 Toshkent => day(8) oynasida 1 soat, day(7) oynasida 2 soat
    const start = tashkentDayStart(day(7)).getTime();
    await ds.query(`INSERT INTO session_events (ts, session_id, machine_id, event, status) VALUES ($1, $2, $3, 'X', 'working'), ($4, $2, $3, 'X', 'idle')`, [new Date(start - H), s, m.id, new Date(start + 2 * H)]);
    const d8 = (await http().get(`/v1/billing/timesheet?from=${day(8)}&to=${day(8)}`).set(auth(readTok)).expect(200)).body as TimesheetDto;
    const d7 = (await http().get(`/v1/billing/timesheet?from=${day(7)}&to=${day(7)}`).set(auth(readTok)).expect(200)).body as TimesheetDto;
    expect(d8.total.activeSeconds).toBe(3600);
    expect(d7.total.activeSeconds).toBe(2 * 3600);
  });

  it("30 kundan uzoq davr: loyiha jami kunlik agregatdan (xom token o'chirilgan), vazifa tokenlari 'to'liq emas'", async () => {
    const m = await one<{ id: string }>(`SELECT id FROM machines WHERE slug = 'wd-mac'`);
    const old = new Date(Date.now() - 41 * 86_400_000);
    await ds.query(
      `INSERT INTO token_usage (ts, machine_id, request_id, session_id, project_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, source)
       VALUES ($1, $2, 'old-1', 'cs-old', $3, 'claude-opus-4-7', 5000, 700, 0, 0, 2.25, 'otel')`,
      [old, m.id, pa],
    );
    await ds.query(`CALL refresh_continuous_aggregate('token_usage_daily_by_project', $1::timestamptz, $2::timestamptz)`, [new Date(old.getTime() - 3 * 86_400_000), new Date(old.getTime() + 3 * 86_400_000)]);
    await ds.query(`SELECT drop_chunks('token_usage', older_than => now() - interval '30 days')`);
    expect(await ds.query(`SELECT 1 FROM token_usage WHERE request_id = 'old-1'`)).toHaveLength(0); // xom yo'q
    const d = tashkentDayOf(old);
    const res = (await http().get(`/v1/billing/timesheet?from=${addDays(d, -1)}&to=${addDays(d, 1)}`).set(auth(readTok)).expect(200)).body as TimesheetDto;
    expect(res.taskTokensPartial).toBe(true);
    const un = res.clients.flatMap((c) => c.projects).find((p) => p.projectKey === 'github.com/acme/app')!;
    expect(un.totals.tokens).toMatchObject({ input: 5000, output: 700 });
    expect(un.totals.costUsd).toBe(2.25);
  });
});

describe('eksport (REST)', () => {
  const q = `from=${day(6)}&to=${day(2)}`;
  const decode = (b: { dataBase64: string }): Buffer => Buffer.from(b.dataBase64, 'base64');

  it("CSV: BOM, formula-neytrallashgan; XLSX ochiladi; PDF to'g'ri; kontrakt", async () => {
    // formula bilan boshlanuvchi mijoz nomi
    await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: '=cmd|calc' }).expect(201);
    const csv = (await http().get(`/v1/billing/timesheet/export?${q}&format=csv`).set(auth(readTok)).expect(200)).body;
    expect(ExportFileSchema.safeParse(csv).success).toBe(true);
    expect(csv.filename).toMatch(/^hisob-kitob_.*\.csv$/);
    const text = decode(csv).toString('utf8');
    expect(text.startsWith('﻿Mijoz,Loyiha')).toBe(true);
    expect(text).toContain('Acme');

    const xlsx = (await http().get(`/v1/billing/timesheet/export?${q}&format=xlsx`).set(auth(readTok)).expect(200)).body;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(decode(xlsx) as never);
    expect(wb.getWorksheet('Batafsil')!.rowCount).toBeGreaterThan(3);
    expect(wb.getWorksheet('Xulosa')!.getRow(4).getCell(1).value).toBe('Acme');

    const pdf = (await http().get(`/v1/billing/timesheet/export?${q}&format=pdf`).set(auth(readTok)).expect(200)).body;
    expect(decode(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    await http().get(`/v1/billing/timesheet/export?${q}&format=exe`).set(auth(readTok)).expect(400);
    await http().get(`/v1/billing/timesheet/export?${q}`).set(auth(readTok)).expect(400);
    await http().get(`/v1/billing/timesheet/export?${q}&format=csv`).expect(401);
  });

  it('eksport auditga yoziladi (GET bo\'lsa ham)', async () => {
    const rows: Array<{ n: number }> = await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'billing.export'`);
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
  });
});

describe('6.8 mijoz hisoboti', () => {
  const body = { from: day(6), to: day(2) };
  const qs = (extra = ''): string => `clientId=${clientId}&from=${day(6)}&to=${day(2)}${extra}`;

  it("ko'rib chiqish: yon ta'sirsiz; yo'l/xesh/mashina nomi/sir YO'Q; progress to'g'ri", async () => {
    const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM client_report_snapshots`);
    const res = await http().get(`/v1/client-reports/preview?${qs()}`).set(auth(readTok)).expect(200);
    expect(ClientReportPreviewSchema.safeParse(res.body).success).toBe(true);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM client_report_snapshots`)).n).toBe(before.n);
    const { model, html } = res.body as { model: { progress: Record<string, number>; groups: Array<{ name: string; done: Array<{ title: string }>; remaining: Array<{ title: string }> }>; summaries: Array<{ lines: string[] }>; activeSeconds: number | null }; html: string };
    expect(model.progress).toMatchObject({ done: 1, inProgress: 1, remaining: 1, total: 3 });
    expect(model.activeSeconds).toBeNull();
    const all = JSON.stringify(model) + html;
    for (const bad of ['/Users', '/home/y', 'a.ts', 'login.tsx', SHA.slice(0, 7), 'wd-ubuntu', 'wd-mac', 'Alex MacBook', 'sk-ant', 'ESKI NOM', 'API_KEY=sk']) expect(all, bad).not.toContain(bad);
    expect(html).toContain('Timesheet va hisobot');
    expect(html).toContain('Login tugadi');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toMatch(/<script|https?:\/\//i);
  });

  it("soatlar faqat so'ralganda; xulosa o'chirilishi mumkin; kalitsiz/ikki ko'lam 400; mijozsiz loyiha 400", async () => {
    const withHours = (await http().get(`/v1/client-reports/preview?${qs('&showHours=1')}`).set(auth(readTok)).expect(200)).body;
    expect(withHours.model.activeSeconds).toBe(3 * 3600);
    expect(withHours.html).toContain('3 soat 00 daqiqa');
    const noSum = (await http().get(`/v1/client-reports/preview?${qs('&showSummary=0')}`).set(auth(readTok)).expect(200)).body;
    expect(noSum.model.summaries).toEqual([]);
    await http().get(`/v1/client-reports/preview?from=${day(6)}&to=${day(2)}`).set(auth(readTok)).expect(400);
    await http().get(`/v1/client-reports/preview?${qs('&projectKey=x')}`).set(auth(readTok)).expect(400);
    const empty = await http().post('/v1/billing/clients').set(auth(ctlTok)).send({ name: 'Bosh' }).expect(201);
    await http().get(`/v1/client-reports/preview?clientId=${empty.body.id}&from=${day(6)}&to=${day(2)}`).set(auth(readTok)).expect(400);
    await http().get(`/v1/client-reports/preview?clientId=00000000-0000-4000-8000-000000000000&from=${day(6)}&to=${day(2)}`).set(auth(readTok)).expect(404);
    const byProject = await http().get(`/v1/client-reports/preview?projectKey=${encodeURIComponent('github.com/acme/app')}&from=${day(6)}&to=${day(2)}&showHours=1`).set(auth(readTok)).expect(200);
    expect(byProject.body.model.title).toBe('proj-a');
    expect(byProject.body.model.activeSeconds).toBe(3 * 3600);
    await http().get(`/v1/client-reports/preview?${qs()}`).expect(401);
  });

  it("yaratish: control kerak; jurnalga yoziladi; xesh fayl bilan mos; audit; Telegram (bot yo'q) = 0 va sent_at yo'q", async () => {
    await http().post('/v1/client-reports').set(auth(readTok)).send({ clientId, ...body }).expect(403);
    await http().post('/v1/client-reports').set(auth(ctlTok)).send({ ...body }).expect(400);
    const res = await http().post('/v1/client-reports').set(auth(ctlTok)).send({ clientId, ...body, showHours: true, sendToOwnerTelegram: true }).expect(201);
    const parsed = CreateClientReportResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    const r = res.body as { snapshot: { id: string; htmlSha256: string; pdfSha256: string; htmlBytes: number; showHours: boolean; clientName: string; telegramSentAt: string | null; actorKind: string }; html: { dataBase64: string; filename: string }; pdf: { dataBase64: string }; telegramDelivered: number | null };
    const html = Buffer.from(r.html.dataBase64, 'base64');
    const pdf = Buffer.from(r.pdf.dataBase64, 'base64');
    expect(createHash('sha256').update(html).digest('hex')).toBe(r.snapshot.htmlSha256);
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(r.snapshot.pdfSha256);
    expect(r.snapshot).toMatchObject({ htmlBytes: html.length, showHours: true, clientName: 'Acme', telegramSentAt: null, actorKind: 'web' });
    expect(r.telegramDelivered).toBe(0);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.html.filename).toMatch(/\.html$/);
    const audit = await ds.query(`SELECT 1 FROM audit_log WHERE action = 'client_report.create'`);
    expect(audit.length).toBeGreaterThanOrEqual(1);

    const list = await http().get('/v1/client-reports').set(auth(readTok)).expect(200);
    expect(ListClientReportSnapshotsResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.items[0].id).toBe(r.snapshot.id);
    // fayl mazmuni jurnalda saqlanmaydi
    const cols: Array<{ column_name: string }> = await ds.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'client_report_snapshots'`);
    expect(cols.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['html', 'content', 'body']));
  });
});
