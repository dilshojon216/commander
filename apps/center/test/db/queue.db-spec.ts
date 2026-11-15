import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { QueueItemDtoSchema, LimitsResponseSchema } from '@commander/contracts';
import type { QueueItemDto } from '@commander/contracts';
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
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { DevicesService } from '../../src/identity/devices/devices.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { QueueModule } from '../../src/queue/queue.module.js';
import { QUEUE_OPTIONS } from '../../src/queue/queue.options.js';
import { QueueSchedulerService } from '../../src/queue/queue-scheduler.service.js';
import { QueueService } from '../../src/queue/queue.service.js';
import { AgentDispatchService } from '../../src/realtime/agent-dispatch.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import type { DomainEvent } from '../../src/realtime/realtime-bus.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/** 3.1: navbat — haqiqiy TimescaleDB; agentd o'rniga soxta sender (`AgentDispatchService`), vaqt `tick(now)` bilan boshqariladi. */

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let hw = 0;
const dispatched: Array<{ machineId: string; type: string; payload: { commandId: string; type: string; payload: { prompt: string; cwd: string; permissionMode: string } } }> = [];
const busEvents: DomainEvent[] = [];

const CONTROL_ON = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };
const SECRET_PROMPT = 'migrate users table; token=sk-ant-abcdefghijklmnop then run tests';

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule, IdentityModule, EventsModule, ApprovalsModule, LimitsModule, ApiModule, AgentModule, RealtimeModule, CommandsModule, QueueModule,
    ],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS).useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS).useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, sweepMs: 3_600_000, keyFile: null, rateLimits: { ...DEFAULT_COMMANDS_OPTIONS.rateLimits, 'session.start': [1000, 60_000] } })
    .overrideProvider(QUEUE_OPTIONS).useValue({ tickMs: 0, keyFile: null, maxStartingNow: 50, blockWhenExhausted: true })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  void (app.getHttpServer().address() as AddressInfo);
  app.get(RealtimeBus).subscribe((e) => void busEvents.push(e));
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

beforeEach(async () => {
  // testlar bir-biriga halaqit bermasin: ochiq elementlar va run'lar yopiladi
  await ds.query(`UPDATE task_queue SET status = 'cancelled', next_run_at = NULL WHERE status IN ('queued', 'waiting_trigger', 'starting')`);
  await ds.query(`UPDATE task_queue_runs SET status = 'failed' WHERE status = 'starting'`);
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const H = 3_600_000;

async function newMachine(name: string, opts: { online?: boolean; control?: Record<string, unknown> | null } = {}): Promise<{ machineId: string; deviceId: string }> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: publicKey.export({ format: 'jwk' }).x as string, hardware_id: `hw-q-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  const machineId = res.body.machine_id as string;
  const deviceId = res.body.device_id as string;
  await ds.query(`UPDATE machines SET online = $2, control = $3::jsonb WHERE id = $1`, [machineId, opts.online ?? true, JSON.stringify(opts.control === undefined ? CONTROL_ON : opts.control)]);
  if (opts.online !== false) {
    svc(AgentDispatchService).register(machineId, {
      deviceId,
      send: (type, payload) => {
        dispatched.push({ machineId, type, payload: payload as never });
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
    `INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = settings.value || $1::jsonb`,
    [JSON.stringify([t.id])],
  );
  return t;
}

const body = (machineId: string, over: Record<string, unknown> = {}) => ({
  machineId, cwd: '/zz/proj', prompt: SECRET_PROMPT, permissionMode: 'plan', model: 'haiku', trigger: { type: 'at', at: at(H).toISOString() }, ...over,
});
const create = (token: string, b: unknown) => http().post('/v1/queue').set(bearer(token)).send(b as object);
const tick = (now: Date) => svc(QueueSchedulerService).tick(now);
const row = async (id: string) => (await ds.query(`SELECT * FROM task_queue WHERE id = $1`, [id]))[0] as Record<string, unknown> & { status: string; attempts: number; next_run_at: Date | null; last_error_code: string | null; fire_seq: number };
const actions = async (target: string): Promise<string[]> => (await ds.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY id`, [target])).map((r: { action: string }) => r.action);

async function completeStart(commandId: string, machineId: string, claudeSessionId = `q-${randomBytes(3).toString('hex')}`): Promise<void> {
  await svc(CommandsService).handleResult(machineId, { commandId, state: 'done', result: { claudeSessionId, shortId: 'abcd1234' } });
  // scheduler `command.changed` ga asinxron javob beradi
  for (let i = 0; i < 100; i += 1) {
    const r = (await ds.query(`SELECT status FROM task_queue_runs WHERE command_id = $1`, [commandId]))[0] as { status: string } | undefined;
    if (!r || r.status !== 'starting') return;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe('yaratish: step-up qoidasi va maxfiylik', () => {
  it('istisno qurilma (Mac dashboard) yaratadi; prompt DB/API/auditda ochiq matn emas', async () => {
    const m = await newMachine('zz-q1');
    const t = await exemptToken();
    const res = await create(t.token, body(m.machineId)).expect(201);
    const item = QueueItemDtoSchema.parse(res.body) as QueueItemDto;
    expect(item).toMatchObject({ status: 'waiting_trigger', confirmation: 'exempt_device', permissionMode: 'plan', promptLength: SECRET_PROMPT.length, createdByDeviceId: t.id });
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-abcdefghijklmnop');

    const raw = (await ds.query(`SELECT prompt_enc, prompt_preview, row_to_json(task_queue)::text AS j FROM task_queue WHERE id = $1`, [item.id]))[0];
    expect(Buffer.from(raw.prompt_enc).toString('utf8')).not.toContain('migrate');
    expect(raw.prompt_preview).not.toContain('sk-ant-abcdefghijklmnop');
    expect(raw.j).not.toContain('sk-ant-abcdefghijklmnop');
    expect(Buffer.from(raw.prompt_enc).toString('latin1')).not.toContain('sk-ant');

    const audit = await ds.query(`SELECT details::text AS d FROM audit_log WHERE target = $1 OR action LIKE 'queue.%'`, [item.id]);
    expect(JSON.stringify(audit)).not.toContain('migrate users');
    expect(await actions(item.id)).toContain('queue.created');
    const r = await row(item.id);
    expect(r['creation_audit_id']).not.toBeNull();
    for (const path of [`/v1/queue`, `/v1/queue/${item.id}`]) expect(JSON.stringify((await http().get(path).set(bearer(t.token)).expect(200)).body)).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('istisnosiz qurilma 422 step_up_required; auto rejim istisnoda ham 422; read scope 403; yaroqsiz tana 400', async () => {
    const m = await newMachine('zz-q2');
    const plain = await issueToken(['read', 'control']);
    const reader = await issueToken(['read']);
    const ex = await exemptToken();
    expect((await create(plain.token, body(m.machineId)).expect(422)).body.error).toBe('step_up_required');
    expect((await create(ex.token, body(m.machineId, { permissionMode: 'auto' })).expect(422)).body.error).toBe('step_up_required');
    await create(reader.token, body(m.machineId)).expect(403);
    await create(ex.token, body(m.machineId, { permissionMode: 'bypassPermissions' })).expect(400);
    await create(ex.token, body(m.machineId, { trigger: { type: 'cron', cron: '*/5 * * * *' } })).expect(400);
    await create(ex.token, body(m.machineId, { trigger: { type: 'at', at: '2020-01-01T00:00:00Z' } })).expect(400);
    expect((await ds.query(`SELECT count(*)::int AS n FROM task_queue WHERE machine_id = $1`, [m.machineId]))[0].n).toBe(0);
  });

  it('Telegram inline tasdiq (auto ham) o\'tadi va elementda yoziladi; inline bayrog\'i boshqa aktor uchun e\'tiborsiz', async () => {
    const m = await newMachine('zz-q3', { control: { ...CONTROL_ON, allowAutoMode: true } });
    const tg = await issueToken(['read', 'control'], 'telegram');
    const q = svc(QueueService);
    const item = await q.create(body(m.machineId, { permissionMode: 'auto' }) as never, { deviceId: tg.id, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' }, T0);
    expect(item).toMatchObject({ confirmation: 'telegram_inline', permissionMode: 'auto' });
    await expect(q.create(body(m.machineId) as never, { deviceId: tg.id, actorKind: 'telegram', ip: null }, T0)).rejects.toMatchObject({ status: 422 });
    await expect(q.create(body(m.machineId) as never, { deviceId: tg.id, actorKind: 'web', ip: null, confirmation: 'telegram_inline' }, T0)).rejects.toMatchObject({ status: 422 });
  });

  it('policy o\'chiq mashinaga yaratish 422; noma\'lum mashina 404', async () => {
    const m = await newMachine('zz-q4', { control: { ...CONTROL_ON, allowStart: false } });
    const ex = await exemptToken();
    expect((await create(ex.token, body(m.machineId)).expect(422)).body.error).toBe('policy_disabled');
    await create(ex.token, body(randomUUID())).expect(404);
  });
});

describe('L-22: yaratgan qurilma revoke qilinsa navbat elementi ishga tushmaydi', () => {
  it('revoke -> faol element darhol bekor (creator_revoked, audit); fire-time tekshiruvi ham to\'siq', async () => {
    const m = await newMachine('zz-q-revoke');
    const t = await exemptToken();
    const item = QueueItemDtoSchema.parse((await create(t.token, body(m.machineId)).expect(201)).body) as QueueItemDto;
    const t2 = await exemptToken();
    const item2 = QueueItemDtoSchema.parse((await create(t2.token, body(m.machineId)).expect(201)).body) as QueueItemDto;

    // 1) revoke hodisasi (DB trigger -> device.event) darhol bekor qiladi
    await svc(DevicesService).revoke(t.id, 'client', 'test');
    for (let i = 0; i < 100 && (await row(item.id)).status !== 'cancelled'; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await row(item.id)).toMatchObject({ status: 'cancelled', last_error_code: 'creator_revoked' });
    expect(await actions(item.id)).toContain('queue.cancelled');

    // 2) hodisa o'tkazib yuborilsa ham scheduler ishga tushirishdan oldin tekshiradi
    await ds.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [t2.id]);
    const n = dispatched.length;
    await tick(new Date(at(H).getTime() + 60_000));
    await new Promise((r) => setTimeout(r, 150));
    expect(await row(item2.id)).toMatchObject({ status: 'cancelled', last_error_code: 'creator_revoked' });
    expect(dispatched.length).toBe(n);
  });
});

describe('scheduler: ishga tushirish', () => {
  it('at: vaqtida system aktori bilan session.start; step-up so\'ralmaydi; audit queue.fired yaratish auditiga havola; haqiqiy prompt agentga boradi', async () => {
    const m = await newMachine('zz-f1');
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    const before = dispatched.length;
    await tick(at(30 * 60_000));
    expect(dispatched.length).toBe(before); // hali erta
    expect((await row(item.id)).status).toBe('waiting_trigger');

    await tick(at(H + 1000));
    const sent = dispatched.slice(before).filter((d) => d.type === 'command.dispatch');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.payload).toMatchObject({ cwd: '/zz/proj', permissionMode: 'plan', prompt: SECRET_PROMPT });
    expect((await row(item.id)).status).toBe('starting');

    const cmd = (await ds.query(`SELECT id, status, step_up_required, requested_by_device_id, confirmed_by_device_id, nonce FROM commands WHERE id = $1`, [sent[0]!.payload.commandId]))[0];
    expect(cmd).toMatchObject({ status: 'sent', step_up_required: false, requested_by_device_id: ex.id, confirmed_by_device_id: ex.id, nonce: `queue-${item.id}-1` });

    const fired = (await ds.query(`SELECT details, actor_kind FROM audit_log WHERE action = 'queue.fired' AND target = $1`, [item.id]))[0];
    const created = (await ds.query(`SELECT id::text AS id FROM audit_log WHERE action = 'queue.created' AND target = $1`, [item.id]))[0];
    expect(fired.actor_kind).toBe('system');
    expect(fired.details).toMatchObject({ creation_audit_id: created.id, creation_confirmation: 'exempt_device', fire_seq: 1 });
    expect(JSON.stringify(fired.details)).not.toContain('migrate users');
    const cc = (await ds.query(`SELECT actor_kind, details FROM audit_log WHERE action = 'command.created' AND target = $1`, [cmd.id]))[0];
    expect(cc).toMatchObject({ actor_kind: 'system' });
    expect(cc.details).toMatchObject({ confirmation: 'queue_item' });
    // queue.fired command.dispatched'dan OLDIN
    const order: string[] = (await ds.query(`SELECT action FROM audit_log WHERE target = ANY($1) ORDER BY id`, [[item.id, cmd.id]])).map((r: { action: string }) => r.action);
    expect(order.indexOf('queue.fired')).toBeLessThan(order.indexOf('command.dispatched'));

    await completeStart(cmd.id, m.machineId, 'q-sess-1');
    const done = await row(item.id);
    expect(done.status).toBe('started');
    expect(done['last_session_id']).not.toBeNull();
    const detail = (await http().get(`/v1/queue/${item.id}`).set(bearer(ex.token)).expect(200)).body;
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ status: 'started', commandId: cmd.id });
    expect(detail.item).toMatchObject({ status: 'started', runCount: 1 });
  });

  it('idempotent: takroriy tik ikkinchi buyruq yaratmaydi; restartdan keyin run buyruqqa nonce orqali bog\'lanadi', async () => {
    const m = await newMachine('zz-f2');
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    const before = dispatched.length;
    await Promise.all([tick(at(H + 1000)), tick(at(H + 1000))]);
    await tick(at(H + 2000));
    expect(dispatched.length - before).toBe(1);
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE nonce = $1`, [`queue-${item.id}-1`]))[0].n).toBe(1);

    // "restart": run'ning command_id yo'qolgan (crash), scheduler holatni DB'dan tiklaydi
    await ds.query(`UPDATE task_queue_runs SET command_id = NULL WHERE queue_id = $1`, [item.id]);
    await svc(QueueSchedulerService).reconcileRuns(at(H + 3000));
    const run = (await ds.query(`SELECT command_id, status FROM task_queue_runs WHERE queue_id = $1`, [item.id]))[0];
    expect(run.command_id).not.toBeNull();
    expect(run.status).toBe('starting');
  });

  it('crash: command yaratilmagan starting run 2 daqiqadan keyin qayta uriniladi (yangi fire_seq), eskisi yo\'qoladi', async () => {
    const m = await newMachine('zz-f3');
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    // fire tranzaksiyasi yozildi, lekin buyruq yaratilmadi:
    await ds.query(`UPDATE task_queue SET status = 'starting', fire_seq = 1, next_run_at = NULL WHERE id = $1`, [item.id]);
    await ds.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, fired_at, status) VALUES ($1, 1, $2, 'starting')`, [item.id, at(H)]);
    await tick(at(H + 60_000)); // hali kutiladi
    expect((await row(item.id)).status).toBe('starting');
    await tick(at(H + 3 * 60_000));
    const r = await row(item.id);
    expect(r.status).toBe('waiting_trigger');
    expect(r.last_error_code).toBe('center_restarted');
    await tick(at(H + 10 * 60_000));
    expect((await ds.query(`SELECT count(*)::int AS n FROM commands WHERE nonce = $1`, [`queue-${item.id}-2`]))[0].n).toBe(1);
  });

  it('lockdown: kechiktiradi (buyruq yo\'q), keyin ishga tushadi', async () => {
    const m = await newMachine('zz-l1');
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    const before = dispatched.length;
    await svc(LockdownService).set(true, 'test');
    try {
      await tick(at(H + 1000));
      const r = await row(item.id);
      expect(r).toMatchObject({ status: 'waiting_trigger', attempts: 0, last_error_code: 'lockdown' });
      expect(r.next_run_at!.getTime()).toBe(at(H + 1000 + 5 * 60_000).getTime());
      expect(dispatched.length).toBe(before);
      await create(ex.token, body(m.machineId)).expect(403); // yaratish ham bloklangan
      await http().post(`/v1/queue/${item.id}/cancel`).set(bearer(ex.token)).expect(403);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    await tick(at(H + 6 * 60_000));
    expect(dispatched.length - before).toBe(1);
  });

  it('mashina offline: urinishlar hisoblanadi, 6 ta urinishdan keyin failed(machine_offline)', async () => {
    const m = await newMachine('zz-o1', { online: false });
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    let now = at(H + 1000);
    for (let i = 1; i <= 5; i += 1) {
      await tick(now);
      expect(await row(item.id)).toMatchObject({ status: 'waiting_trigger', attempts: i, last_error_code: 'machine_offline' });
      now = new Date(now.getTime() + 5 * 60_000 + 1000);
    }
    await tick(now);
    expect(await row(item.id)).toMatchObject({ status: 'failed', last_error_code: 'machine_offline' });
    expect(await actions(item.id)).toContain('queue.failed');
  });

  it('policy rad etadi (fire paytida allowStart o\'chgan): failed + sabab; takroriy emas', async () => {
    const m = await newMachine('zz-p1');
    const ex = await exemptToken();
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    await ds.query(`UPDATE machines SET control = $2::jsonb WHERE id = $1`, [m.machineId, JSON.stringify({ ...CONTROL_ON, enabled: false })]);
    await tick(at(H + 1000));
    const r = await row(item.id);
    expect(r.status).toBe('failed');
    expect(r.last_error_code).toBe('policy_disabled');
    const runs = await ds.query(`SELECT status, error_code FROM task_queue_runs WHERE queue_id = $1`, [item.id]);
    expect(runs).toEqual([{ status: 'failed', error_code: 'policy_disabled' }]);
  });

  it('maxConcurrentStarted: kechiktiriladi; limit tugagan (100%): kechiktiriladi, sozlama o\'chirilsa ishga tushadi', async () => {
    const m = await newMachine('zz-c1', { control: { ...CONTROL_ON, maxConcurrentStarted: 1 } });
    const ex = await exemptToken();
    await ds.query(
      `INSERT INTO sessions (machine_id, claude_session_id, cwd, project, kind, started_by, status, model, permission_mode, started_at, status_since, last_seen_at)
       VALUES ($1, 'busy-1', '/zz/proj', 'proj', 'bg', 'remote', 'idle', 'haiku', 'plan', now(), now(), now())`,
      [m.machineId],
    );
    const item = (await create(ex.token, body(m.machineId)).expect(201)).body as QueueItemDto;
    await tick(at(H + 1000));
    expect(await row(item.id)).toMatchObject({ status: 'waiting_trigger', last_error_code: 'too_many_sessions' });
    await ds.query(`UPDATE sessions SET ended_at = now() WHERE machine_id = $1`, [m.machineId]);

    // limit 100%
    const now = at(H + 20 * 60_000);
    await ds.query(
      `INSERT INTO limit_samples (ts, machine_id, source, five_hour_used_pct, five_hour_resets_at) VALUES ($1, $2, 'official', 100, $3)`,
      [new Date(now.getTime() - 1000), m.machineId, new Date(now.getTime() + 2 * H)],
    );
    await tick(now);
    expect(await row(item.id)).toMatchObject({ status: 'waiting_trigger', last_error_code: 'limit_exhausted' });
    await ds.query(`INSERT INTO settings (key, value) VALUES ('queue.block_when_limit_exhausted', 'false'::jsonb) ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`);
    const before = dispatched.length;
    await tick(at(H + 40 * 60_000));
    expect(dispatched.length - before).toBe(1);
    await ds.query(`DELETE FROM settings WHERE key = 'queue.block_when_limit_exhausted'`);
    await ds.query(`DELETE FROM limit_samples WHERE machine_id = $1`, [m.machineId]);
  });
});

describe('limit_reset va cron', () => {
  it('limit_reset: keyingi reset + 60 s da ishga tushadi; kuzatuv bo\'lmasa keyin bog\'lanadi', async () => {
    const m = await newMachine('zz-r1');
    const ex = await exemptToken();
    const reset = new Date(Date.now() + 2 * H);
    await ds.query(`INSERT INTO limit_samples (ts, machine_id, source, five_hour_used_pct, five_hour_resets_at) VALUES (now(), $1, 'official', 40, $2)`, [m.machineId, reset]);
    const item = (await create(ex.token, body(m.machineId, { trigger: { type: 'limit_reset', window: '5h' } })).expect(201)).body as QueueItemDto;
    expect(new Date(item.nextRunAt!).getTime()).toBe(reset.getTime() + 60_000);
    const before = dispatched.length;
    await tick(new Date(reset.getTime() + 30_000));
    expect(dispatched.length).toBe(before);
    await tick(new Date(reset.getTime() + 61_000));
    expect(dispatched.length - before).toBe(1);

    // haftalik oyna: kuzatuv yo'q => next_run_at null, keyin bog'lanadi
    await ds.query(`DELETE FROM limit_samples WHERE machine_id = $1`, [m.machineId]);
    const w = (await create(ex.token, body(m.machineId, { trigger: { type: 'limit_reset', window: '7d' } })).expect(201)).body as QueueItemDto;
    expect(w.nextRunAt).toBeNull();
    const weekly = new Date(Date.now() + 3 * 24 * H);
    await ds.query(`INSERT INTO limit_samples (ts, machine_id, source, seven_day_used_pct, seven_day_resets_at) VALUES (now(), $1, 'official', 10, $2)`, [m.machineId, weekly]);
    await tick(new Date());
    expect(new Date((await row(w.id)).next_run_at as unknown as string).getTime()).toBe(weekly.getTime() + 60_000);
  });

  it('cron: har chiqish yangi sessiya, tarix saqlanadi, keyingi chiqish Toshkent vaqti bo\'yicha', async () => {
    const m = await newMachine('zz-cr1');
    const ex = await exemptToken();
    const created = (await create(ex.token, body(m.machineId, { trigger: { type: 'cron', cron: '0 2 * * *' } })).expect(201)).body as QueueItemDto;
    // Keyingi 02:00 Toshkent = 21:00 UTC (real "hozir"ga nisbatan)
    const first = new Date(created.nextRunAt!);
    expect(first.getUTCHours()).toBe(21);
    expect(first.getUTCMinutes()).toBe(0);
    const before = dispatched.length;
    await tick(new Date(first.getTime() + 1000));
    const r1 = await row(created.id);
    expect(r1.status).toBe('waiting_trigger');
    expect(r1.next_run_at!.getTime()).toBe(first.getTime() + 24 * H);
    const cmd1 = dispatched[dispatched.length - 1]!.payload.commandId;
    await completeStart(cmd1, m.machineId, 'cron-s1');
    expect((await row(created.id)).status).toBe('waiting_trigger'); // takroriy: started'ga o'tmaydi

    await tick(new Date(first.getTime() + 24 * H + 1000));
    await completeStart(dispatched[dispatched.length - 1]!.payload.commandId, m.machineId, 'cron-s2');
    expect(dispatched.length - before).toBe(2);
    const detail = (await http().get(`/v1/queue/${created.id}`).set(bearer(ex.token)).expect(200)).body;
    expect(detail.runs.map((r: { status: string }) => r.status)).toEqual(['started', 'started']);
    expect(new Set(detail.runs.map((r: { sessionId: string }) => r.sessionId)).size).toBe(2);
    expect(detail.item.runCount).toBe(2);
  });
});

describe('REST: ro\'yxat, tahrirlash, bekor, run-now, o\'chirish; push', () => {
  it('filtrlar, PATCH (trigger/prompt: prompt qayta step-up), cancel, run-now, delete', async () => {
    const m = await newMachine('zz-rest');
    const ex = await exemptToken();
    const plain = await issueToken(['read', 'control']);
    const a = (await create(ex.token, body(m.machineId, { taskKey: '3.1' })).expect(201)).body as QueueItemDto;
    const b = (await create(ex.token, body(m.machineId, { trigger: { type: 'limit_reset', window: '7d' } })).expect(201)).body as QueueItemDto;
    const list = (await http().get(`/v1/queue?machine=${m.machineId}`).set(bearer(ex.token)).expect(200)).body.items as QueueItemDto[];
    expect(list.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect((await http().get(`/v1/queue?machine=${m.machineId}&triggerType=limit_reset`).set(bearer(ex.token)).expect(200)).body.items).toHaveLength(1);
    expect((await http().get(`/v1/queue?machine=${m.machineId}&status=failed`).set(bearer(ex.token)).expect(200)).body.items).toHaveLength(0);
    await http().get(`/v1/queue/${randomUUID()}`).set(bearer(ex.token)).expect(404);

    // PATCH
    const p1 = (await http().patch(`/v1/queue/${a.id}`).set(bearer(ex.token)).send({ trigger: { type: 'at', at: at(5 * H).toISOString() }, model: 'sonnet' }).expect(200)).body as QueueItemDto;
    expect(p1).toMatchObject({ model: 'sonnet', trigger: { type: 'at' } });
    await http().patch(`/v1/queue/${a.id}`).set(bearer(plain.token)).send({ prompt: 'other work' }).expect(422); // istisnosiz: prompt o'zgartirib bo'lmaydi
    const p2 = (await http().patch(`/v1/queue/${a.id}`).set(bearer(ex.token)).send({ prompt: 'rewritten task' }).expect(200)).body as QueueItemDto;
    expect(p2.promptPreview).toBe('rewritten task');
    await http().patch(`/v1/queue/${a.id}`).set(bearer(ex.token)).send({}).expect(400);
    await http().patch(`/v1/queue/${a.id}`).set(bearer(ex.token)).send({ cwd: '/etc' }).expect(400);

    // run-now: trigger kutilmaydi
    const before = dispatched.length;
    const rn = (await http().post(`/v1/queue/${a.id}/run-now`).set(bearer(ex.token)).expect(200)).body as QueueItemDto;
    expect(rn.status).toBe('starting');
    expect(dispatched.slice(before).filter((d) => d.payload.payload.prompt === 'rewritten task')).toHaveLength(1);
    await http().post(`/v1/queue/${a.id}/run-now`).set(bearer(ex.token)).expect(409);
    await http().patch(`/v1/queue/${a.id}`).set(bearer(ex.token)).send({ model: 'haiku' }).expect(409);

    // cancel + delete
    expect((await http().post(`/v1/queue/${b.id}/cancel`).set(bearer(ex.token)).expect(200)).body.status).toBe('cancelled');
    await http().delete(`/v1/queue/${a.id}`).set(bearer(ex.token)).expect(409); // faol
    expect((await http().delete(`/v1/queue/${b.id}`).set(bearer(ex.token)).expect(200)).body).toEqual({ deleted: true });
    await http().get(`/v1/queue/${b.id}`).set(bearer(ex.token)).expect(404);
    expect(await actions(a.id)).toEqual(expect.arrayContaining(['queue.created', 'queue.updated', 'queue.run_now', 'queue.fired']));
  });

  it('bus: queue.changed e\'lon qilinadi; GET /v1/limits forecast maydonini additiv beradi', async () => {
    expect(busEvents.some((e) => e.type === 'queue.changed')).toBe(true);
    const ex = await exemptToken();
    const res = await http().get('/v1/limits').set(bearer(ex.token)).expect(200);
    const parsed = LimitsResponseSchema.parse(res.body);
    expect(parsed).toHaveProperty('fiveHour');
  });
});
