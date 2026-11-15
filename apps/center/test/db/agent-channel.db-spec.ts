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
import { AGENT_WS_CLOSE, AGENT_WS_PATH, buildAgentAuthString, createEnvelope } from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { AgentIngestService } from '../../src/agent/agent-ingest.service.js';
import { AgentPresenceService } from '../../src/agent/agent-presence.service.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { DevicesService } from '../../src/identity/devices/devices.service.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { SessionsV1Service } from '../../src/api/sessions-v1.service.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;
const LEGACY = 'legacy-hook-secret';

/** 1.4 e2e: haqiqiy TimescaleDB + haqiqiy `ws` mijoz + haqiqiy Ed25519. */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Agent {
  ws: WebSocket;
  deviceId: string;
  machineId: string;
  keys: { priv: KeyObject; pubB64: string };
  next: (ms?: number) => Promise<Msg>;
  send: (m: unknown) => void;
  closed: Promise<number>;
}

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let wsUrl: string;
let hw = 0;

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: LEGACY })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      IdentityModule,
      EventsModule,
      AgentModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 1200, revokeCheckIntervalMs: 100 })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  // Ko'p ulanish/xato bir oynada: global qator byudjeti testni overflow'ga yig'ib yubormasin.
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  wsUrl = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${AGENT_WS_PATH}`;
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function enroll(): Promise<{ deviceId: string; machineId: string; keys: Agent['keys'] }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-1.4' }, 'test');
  const res = await request(app.getHttpServer())
    .post('/v1/enroll')
    .send({ code, public_key: keys.pubB64, hardware_id: `hw-1.4-${++hw}-${randomBytes(4).toString('hex')}`, hostname: 'zz-test-1.4-host', os: 'darwin', arch: 'arm64' })
    .expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys };
}

function open(): { ws: WebSocket; next: Agent['next']; send: Agent['send']; closed: Promise<number>; opened: Promise<void> } {
  const ws = new WebSocket(wsUrl);
  const inbox: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    next: (ms = 3000) =>
      new Promise((resolve, reject) => {
        const m = inbox.shift();
        if (m) return resolve(m);
        const t = setTimeout(() => reject(new Error('timeout waiting for a message')), ms);
        waiters.push((x) => { clearTimeout(t); resolve(x); });
      }),
  };
}

function authEnvelope(nonce: string, deviceId: string, priv: KeyObject, ts = Date.now()) {
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce, ts, deviceId }), 'utf8'), priv).toString('base64url');
  return createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0-test', claudeVersion: '2.1.304', hostname: 'zz-test-1.4-host', os: 'darwin' });
}

async function connectAgent(e: { deviceId: string; machineId: string; keys: Agent['keys'] }): Promise<Agent> {
  const c = open();
  await c.opened;
  const ch = await c.next();
  c.send(authEnvelope(ch.payload.nonce as string, e.deviceId, e.keys.priv));
  const ok = await c.next();
  expect(ok.type).toBe('auth.ok');
  return { ws: c.ws, deviceId: e.deviceId, machineId: e.machineId, keys: e.keys, next: c.next, send: c.send, closed: c.closed };
}

const ev = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), claudeSessionId: 's-1', event: 'PreToolUse', status: 'working', cwd: '/zz/work/commander', ts: Date.now(), ...over,
});
const usage = (over: Record<string, unknown> = {}) => ({
  requestId: `req_${randomBytes(4).toString('hex')}`, claudeSessionId: 's-1', cwd: '/zz/work/commander', model: 'claude-test',
  inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.0123, source: 'otel' as const, ts: Date.now(), ...over,
});

async function roundtrip(a: Agent, env: ReturnType<typeof createEnvelope>): Promise<Msg> {
  a.send(env);
  return a.next();
}

describe('authentication', () => {
  it('rejects a bad signature, an unknown device and a stale ts; nothing is marked online; failures are audited as ws-challenge', async () => {
    const e = await enroll();

    for (const make of [
      (nonce: string) => authEnvelope(nonce, e.deviceId, generateKeyPairSync('ed25519').privateKey),
      (nonce: string) => authEnvelope(nonce, randomUUID(), e.keys.priv),
      (nonce: string) => authEnvelope(nonce, e.deviceId, e.keys.priv, Date.now() - 10 * 60_000),
    ]) {
      const c = open();
      await c.opened;
      const ch = await c.next();
      c.send(make(ch.payload.nonce as string));
      const err = await c.next();
      expect(err.type).toBe('auth.error');
      expect(await c.closed).toBe(AGENT_WS_CLOSE.authFailed);
    }
    const [m] = await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]);
    expect(m.online).toBe(false);

    svc(FailureAggregator).flush(Date.now(), true);
    const rows = await eventually(
      () => ds.query(`SELECT details FROM audit_log WHERE action = 'auth.failed' AND details->>'scheme' = 'ws-challenge'`),
      (r: unknown[]) => r.length >= 2,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rows)).not.toContain(e.keys.pubB64);
  });

  it("a nonce from one connection is useless on another (replay of a captured auth.response)", async () => {
    const e = await enroll();
    const a = open();
    await a.opened;
    const chA = await a.next();
    const captured = authEnvelope(chA.payload.nonce as string, e.deviceId, e.keys.priv);
    a.ws.close();
    await a.closed;

    const b = open();
    await b.opened;
    await b.next(); // challenge B (boshqa nonce)
    b.send(captured);
    expect((await b.next()).payload.code).toBe('unauthorized');
    expect(await b.closed).toBe(AGENT_WS_CLOSE.authFailed);
  });

  it('a client token / non-agentd principal cannot authenticate (unknown device)', async () => {
    const c = open();
    await c.opened;
    const ch = await c.next();
    c.send(authEnvelope(ch.payload.nonce as string, randomUUID(), generateKeyPairSync('ed25519').privateKey));
    expect((await c.next()).payload.code).toBe('unauthorized');
  });
});

describe('ingest: idempotency and acks', () => {
  it('events: sent twice (same envelope) -> two acks, ONE session_events row, session state applied', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const event = ev({ claudeSessionId: 's-idem', status: 'awaiting_approval', event: 'PermissionRequest', message: 'Bash: ls', transcriptPath: '/zz/t.jsonl' });
    const env = createEnvelope('agent.events', { events: [event] });

    const ack1 = await roundtrip(a, env);
    const ack2 = await roundtrip(a, env);
    expect(ack1).toMatchObject({ type: 'ack', payload: { ids: [env.id] } });
    expect(ack2).toMatchObject({ type: 'ack', payload: { ids: [env.id] } });

    const rows = await ds.query(`SELECT event, status, message FROM session_events WHERE machine_id = $1 AND event_id = $2`, [e.machineId, event.eventId]);
    expect(rows).toHaveLength(1);
    const [s] = await ds.query(`SELECT status, message, transcript_path, project_id FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-idem'`, [e.machineId]);
    expect(s).toMatchObject({ status: 'awaiting_approval', message: 'Bash: ls', transcript_path: '/zz/t.jsonl' });
    expect(s.project_id).not.toBeNull();

    // yangi envelope.id, o'sha eventId (agentd outbox qayta yuboradi)
    const again = createEnvelope('agent.events', { events: [event] });
    expect((await roundtrip(a, again)).type).toBe('ack');
    expect(await ds.query(`SELECT 1 FROM session_events WHERE machine_id = $1 AND event_id = $2`, [e.machineId, event.eventId])).toHaveLength(1);
    a.ws.close();
  });

  it('events: batch with several sessions, out-of-order older event is logged but does not override the newer state', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const t = Date.now();
    const newer = ev({ claudeSessionId: 's-ooo', status: 'working', ts: t });
    const older = ev({ claudeSessionId: 's-ooo', status: 'done', event: 'Stop', ts: t - 60_000 });
    const other = ev({ claudeSessionId: 's-other', status: 'idle', event: 'SessionStart', ts: t });
    await roundtrip(a, createEnvelope('agent.events', { events: [newer] }));
    await roundtrip(a, createEnvelope('agent.events', { events: [older, other] }));

    const [s] = await ds.query(`SELECT status FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-ooo'`, [e.machineId]);
    expect(s.status).toBe('working');
    expect(await ds.query(`SELECT 1 FROM session_events se JOIN sessions s ON s.id = se.session_id WHERE s.machine_id = $1 AND s.claude_session_id = 's-ooo'`, [e.machineId])).toHaveLength(2);
    expect(await ds.query(`SELECT 1 FROM sessions WHERE machine_id = $1`, [e.machineId])).toHaveLength(2);
    a.ws.close();
  });

  it('events: ended with reason is stored; a later working event reopens the session and clears it', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const t = Date.now();
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-end', status: 'ended', event: 'SessionEnd', reason: 'vanished', ts: t })] }));
    const [ended] = await ds.query(`SELECT status, end_reason, ended_at FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-end'`, [e.machineId]);
    expect(ended).toMatchObject({ status: 'ended', end_reason: 'vanished' });
    expect(ended.ended_at).not.toBeNull();
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-end', status: 'working', ts: t + 1000 })] }));
    const [back] = await ds.query(`SELECT status, end_reason, ended_at FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-end'`, [e.machineId]);
    expect(back).toMatchObject({ status: 'working', end_reason: null, ended_at: null });
    a.ws.close();
  });

  it('usage: sent twice -> ONE token_usage row; project attributed via upsert_project; same request with another ts is a separate row', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const rec = usage();
    const env = createEnvelope('agent.usage', { records: [rec] });
    expect((await roundtrip(a, env)).type).toBe('ack');
    expect((await roundtrip(a, env)).type).toBe('ack');

    const rows = await ds.query(`SELECT * FROM token_usage WHERE machine_id = $1 AND request_id = $2`, [e.machineId, rec.requestId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-test', source: 'otel', session_id: 's-1' });
    expect(Number(rows[0].input_tokens)).toBe(100);
    expect(Number(rows[0].cache_read_tokens)).toBe(1000);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0123, 6);
    expect(new Date(rows[0].ts).getTime()).toBe(rec.ts);

    const [proj] = await ds.query(`SELECT id, path, kind FROM projects WHERE machine_id = $1 AND path = $2`, [e.machineId, '/zz/work/commander']);
    expect(rows[0].project_id).toBe(proj.id);
    expect(proj.kind).toBe('dir');

    // cwd'siz yozuv: project_id NULL
    const noCwd = usage({ cwd: undefined });
    await roundtrip(a, createEnvelope('agent.usage', { records: [noCwd] }));
    const [n] = await ds.query(`SELECT project_id FROM token_usage WHERE machine_id = $1 AND request_id = $2`, [e.machineId, noCwd.requestId]);
    expect(n.project_id).toBeNull();

    // transcript manbasi, o'sha request va o'sha ts: dublikat (dedup manbalar orasida ham)
    await roundtrip(a, createEnvelope('agent.usage', { records: [{ ...rec, source: 'transcript' }] }));
    expect(await ds.query(`SELECT 1 FROM token_usage WHERE machine_id = $1 AND request_id = $2`, [e.machineId, rec.requestId])).toHaveLength(1);

    // dublikatlar bitta batch ichida
    const dup = usage();
    await roundtrip(a, createEnvelope('agent.usage', { records: [dup, dup] }));
    expect(await ds.query(`SELECT 1 FROM token_usage WHERE machine_id = $1 AND request_id = $2`, [e.machineId, dup.requestId])).toHaveLength(1);

    // faqat ts farqi: ikkinchi qator (kontrakt shuni taqiqlaydi)
    await roundtrip(a, createEnvelope('agent.usage', { records: [{ ...rec, ts: rec.ts + 1 }] }));
    expect(await ds.query(`SELECT 1 FROM token_usage WHERE machine_id = $1 AND request_id = $2`, [e.machineId, rec.requestId])).toHaveLength(2);
    a.ws.close();
  });

  it('limits: sent twice -> ONE limit_samples row, source official; per-window values stored', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const observedAt = Date.now();
    const payload = {
      observedAt,
      claudeSessionId: 's-1',
      fiveHour: { usedPct: 87.5, resetsAt: observedAt + 3_600_000 },
      sevenDay: { usedPct: 12.25, resetsAt: observedAt + 86_400_000 },
    };
    const env = createEnvelope('agent.limits', payload);
    expect((await roundtrip(a, env)).type).toBe('ack');
    expect((await roundtrip(a, env)).type).toBe('ack');
    const rows = await ds.query(`SELECT * FROM limit_samples WHERE machine_id = $1`, [e.machineId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'official', session_id: 's-1' });
    expect(Number(rows[0].five_hour_used_pct)).toBe(87.5);
    expect(Number(rows[0].seven_day_used_pct)).toBe(12.25);
    expect(new Date(rows[0].five_hour_resets_at).getTime()).toBe(payload.fiveHour.resetsAt);
    expect(new Date(rows[0].ts).getTime()).toBe(observedAt);

    // faqat bitta oyna
    await roundtrip(a, createEnvelope('agent.limits', { observedAt: observedAt + 1, sevenDay: { usedPct: 13, resetsAt: observedAt + 86_400_000 } }));
    const [only] = await ds.query(`SELECT five_hour_used_pct, seven_day_used_pct FROM limit_samples WHERE machine_id = $1 AND ts > $2`, [e.machineId, new Date(observedAt)]);
    expect(only.five_hour_used_pct).toBeNull();
    a.ws.close();
  });

  it('invalid payload -> non-retriable nack, no rows; the connection stays usable', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const bad = createEnvelope('agent.usage', { records: [{ requestId: 'r', model: 'm' }] });
    const nack = await roundtrip(a, bad);
    expect(nack).toMatchObject({ type: 'nack', payload: { id: bad.id, code: 'invalid_payload', retriable: false } });
    expect(await ds.query(`SELECT 1 FROM token_usage WHERE machine_id = $1`, [e.machineId])).toHaveLength(0);
    expect((await roundtrip(a, createEnvelope('agent.usage', { records: [usage()] }))).type).toBe('ack');
    a.ws.close();
  });

  it('is NOT blocked by lockdown (telemetry); no audit row per telemetry message', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const noise = `action NOT IN ('lockdown.changed', 'agent.connected', 'agent.disconnected', 'device.enrolled', 'enrollment_code.created', 'enrollment_code.used', 'auth.failed', 'audit.overflow')`;
    const before = (await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE ${noise}`))[0].n as number;
    const lockBefore = (await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'lockdown.changed'`))[0].n as number;
    await svc(LockdownService).set(true, 'test');
    try {
      for (let i = 0; i < 10; i++) {
        expect((await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-lock' })] }))).type).toBe('ack');
        expect((await roundtrip(a, createEnvelope('agent.usage', { records: [usage()] }))).type).toBe('ack');
      }
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    // 20 ta telemetriya xabari hech qanday audit qatori qo'shmaydi (lockdown on/off va ulanish qatorlaridan tashqari)
    const after = (await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE ${noise}`))[0].n as number;
    expect(after).toBe(before);
    expect((await ds.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'lockdown.changed'`))[0].n - lockBefore).toBe(2);
    a.ws.close();
  });
});

describe('AgentIngestService counts (no socket)', () => {
  it('reports inserted vs duplicates for usage, events and limits', async () => {
    const e = await enroll();
    const ing = svc(AgentIngestService);
    const rec = usage();
    expect(await ing.ingestUsage(e.machineId, [rec, usage()])).toEqual({ inserted: 2, duplicates: 0 });
    expect(await ing.ingestUsage(e.machineId, [rec])).toEqual({ inserted: 0, duplicates: 1 });

    const event = ev({ claudeSessionId: 's-cnt' });
    const parsed = { ...event } as unknown as Parameters<AgentIngestService['ingestEvents']>[1][number];
    expect(await ing.ingestEvents(e.machineId, [parsed])).toEqual({ inserted: 1, duplicates: 0 });
    expect(await ing.ingestEvents(e.machineId, [parsed])).toEqual({ inserted: 0, duplicates: 1 });

    const lim = { observedAt: Date.now(), fiveHour: { usedPct: 1, resetsAt: Date.now() + 1000 } };
    expect(await ing.ingestLimits(e.machineId, lim)).toEqual({ inserted: 1, duplicates: 0 });
    expect(await ing.ingestLimits(e.machineId, lim)).toEqual({ inserted: 0, duplicates: 1 });
  });
});

describe('permissionMode', () => {
  const sessionsV1 = (): SessionsV1Service => new SessionsV1Service(ds, { get: () => undefined } as never);
  it("agent.events.permissionMode sessions'ga yoziladi, DTO'da qaytadi; rejimsiz hodisa avvalgisini saqlaydi", async () => {
    const e = await enroll();
    const ing = svc(AgentIngestService);
    const at = Date.now() - 5000;
    const mk = (over: Record<string, unknown>) => ev({ claudeSessionId: 's-perm', ...over }) as unknown as Parameters<AgentIngestService['ingestEvents']>[1][number];
    await ing.ingestEvents(e.machineId, [mk({ ts: at, status: 'idle', event: 'SessionStart', permissionMode: 'default' })]);
    const [row1] = await ds.query(`SELECT id, permission_mode FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-perm'`, [e.machineId]);
    expect(row1.permission_mode).toBe('default');
    expect((await sessionsV1().get(row1.id)).permissionMode).toBe('default');

    await ing.ingestEvents(e.machineId, [mk({ ts: at + 1000, status: 'working', event: 'UserPromptSubmit', permissionMode: 'plan' })]);
    expect((await sessionsV1().get(row1.id)).permissionMode).toBe('plan');
    // rejim yo'q (eski agentd / v0): avvalgisi saqlanadi
    await ing.ingestEvents(e.machineId, [mk({ ts: at + 2000, status: 'done', event: 'Stop' })]);
    expect((await sessionsV1().get(row1.id)).permissionMode).toBe('plan');
    // 32 belgidan uzun rejim kontraktda rad etiladi (DB CHECK ham)
    await expect(ds.query(`UPDATE sessions SET permission_mode = $1 WHERE id = $2`, ['x'.repeat(33), row1.id])).rejects.toThrow(/chk_sessions_permission_mode_len/);
  });
});

describe('presence', () => {
  it('connect -> online; disconnect -> offline + open sessions stale (status unchanged); reconnect clears stale', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-open', status: 'working' }), ev({ claudeSessionId: 's-done', status: 'ended', event: 'SessionEnd' })] }));
    const [m1] = await ds.query(`SELECT online, agentd_version, claude_version, hostname FROM machines WHERE id = $1`, [e.machineId]);
    expect(m1).toMatchObject({ online: true, agentd_version: '0.1.0-test', claude_version: '2.1.304', hostname: 'zz-test-1.4-host' });

    a.ws.close();
    await a.closed;
    const off = await eventually(() => ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]), (r: Array<{ online: boolean }>) => !r[0].online);
    expect(off[0].online).toBe(false);
    const stale = await ds.query(`SELECT claude_session_id, status, stale_since FROM sessions WHERE machine_id = $1 ORDER BY claude_session_id`, [e.machineId]);
    expect(stale.find((s: { claude_session_id: string }) => s.claude_session_id === 's-open')).toMatchObject({ status: 'working' });
    expect(stale.find((s: { claude_session_id: string }) => s.claude_session_id === 's-open').stale_since).not.toBeNull();
    expect(stale.find((s: { claude_session_id: string }) => s.claude_session_id === 's-done').stale_since).toBeNull(); // tugagan sessiya stale emas

    const b = await connectAgent(e);
    const back = await ds.query(`SELECT stale_since FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-open'`, [e.machineId]);
    expect(back[0].stale_since).toBeNull();
    b.ws.close();
  });

  it('60 s (here 1.2 s) without messages: closed with 4011 and marked offline; heartbeats keep it online', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 400));
      a.send(createEnvelope('agent.heartbeat', { activeSessions: [], load: 0.5 }));
    }
    expect((await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]))[0].online).toBe(true);
    expect(await a.closed).toBe(AGENT_WS_CLOSE.heartbeatTimeout);
    const off = await eventually(() => ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]), (r: Array<{ online: boolean }>) => !r[0].online);
    expect(off[0].online).toBe(false);
  }, 15_000);

  it('heartbeat activeSessions refresh last_seen_at of listed open sessions', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-hb', ts: Date.now() - 3_000 })] }));
    const [before] = await ds.query(`SELECT last_seen_at FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-hb'`, [e.machineId]);
    a.send(createEnvelope('agent.heartbeat', { activeSessions: [{ claudeSessionId: 's-hb' }] }));
    const after = await eventually(
      () => ds.query(`SELECT last_seen_at FROM sessions WHERE machine_id = $1 AND claude_session_id = 's-hb'`, [e.machineId]),
      (r: Array<{ last_seen_at: Date }>) => r[0].last_seen_at.getTime() > before.last_seen_at.getTime(),
    );
    expect(after[0].last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());
    a.ws.close();
  });

  it('a second connection for the same device replaces the first (4009); the machine stays online', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const b = await connectAgent(e);
    expect(await a.closed).toBe(AGENT_WS_CLOSE.replaced);
    await new Promise((r) => setTimeout(r, 150));
    expect((await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]))[0].online).toBe(true);
    expect((await roundtrip(b, createEnvelope('agent.events', { events: [ev()] }))).type).toBe('ack');
    b.ws.close();
  });

  it('startup reset marks every machine offline and its open sessions stale', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    await roundtrip(a, createEnvelope('agent.events', { events: [ev({ claudeSessionId: 's-reset' })] }));
    a.ws.terminate();
    await a.closed;
    await eventually(() => ds.query(`SELECT stale_since FROM sessions WHERE machine_id = $1`, [e.machineId]), (r: Array<{ stale_since: Date | null }>) => r[0].stale_since !== null);
    await ds.query(`UPDATE machines SET online = true WHERE id = $1`, [e.machineId]);
    await ds.query(`UPDATE sessions SET stale_since = NULL WHERE machine_id = $1`, [e.machineId]);
    const n = await svc(AgentPresenceService).resetAllOffline();
    expect(n).toBe(1); // faqat shu mashina online edi
    expect((await ds.query(`SELECT online FROM machines WHERE id = $1`, [e.machineId]))[0].online).toBe(false);
    expect((await ds.query(`SELECT stale_since FROM sessions WHERE machine_id = $1`, [e.machineId]))[0].stale_since).not.toBeNull();
  });
});

describe('revocation and audit', () => {
  it('revoked device cannot authenticate (4010) and a connected one is cut off on its next message', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    await svc(DevicesService).revoke(e.deviceId, 'agentd', 'test');
    await new Promise((r) => setTimeout(r, 150)); // revokeCheckIntervalMs = 100
    a.send(createEnvelope('agent.heartbeat', {}));
    expect(await a.closed).toBe(AGENT_WS_CLOSE.revoked);

    const c = open();
    await c.opened;
    const ch = await c.next();
    c.send(authEnvelope(ch.payload.nonce as string, e.deviceId, e.keys.priv));
    expect((await c.next()).payload.code).toBe('device_revoked');
    expect(await c.closed).toBe(AGENT_WS_CLOSE.revoked);
  });

  it('connect and disconnect are audited (aggregated), with the machine as target', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    a.ws.close();
    await a.closed;
    await new Promise((r) => setTimeout(r, 100));
    svc(FailureAggregator).flush(Date.now(), true);
    const rows = await eventually(
      () => ds.query(`SELECT action, target, actor_kind FROM audit_log WHERE actor_device_id = $1 ORDER BY id`, [e.deviceId]),
      (r: Array<{ action: string }>) => r.some((x) => x.action === 'agent.disconnected'),
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['agent.connected', 'agent.disconnected']));
    expect(rows.find((r: { action: string }) => r.action === 'agent.connected')).toMatchObject({ target: e.machineId, actor_kind: 'agentd' });
  });
});

describe('M-10: legacy POST /events and GET /sessions are removed', () => {
  it('both are 404 even with the old shared AUTH_TOKEN; no session row is created', async () => {
    const http = app.getHttpServer();
    const body = { host: 'zz-legacy-1.4', session_id: 'legacy-1', cwd: '/zz/legacy', event: 'Notification', status: 'waiting', ts: Date.now() };
    await request(http).post('/events').set('Authorization', `Bearer ${LEGACY}`).send(body).expect(404);
    await request(http).post('/events').send(body).expect(404);
    await request(http).get('/sessions').set('Authorization', `Bearer ${LEGACY}`).expect(404);
    const rows = await ds.query(`SELECT 1 FROM machines WHERE legacy_host = 'zz-legacy-1.4'`);
    expect(rows).toHaveLength(0);
  });
});
