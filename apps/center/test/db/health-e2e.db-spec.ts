import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { AGENT_WS_PATH, buildAgentAuthString, createEnvelope } from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { HealthAlertsModule } from '../../src/health-alerts/health-alerts.module.js';
import { MachineHealthService } from '../../src/health/machine-health.service.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { TelegramService } from '../../src/telegram/telegram.service.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/** 3.8 e2e: haqiqiy agentd WS -> `agent.health` -> machine_health -> hodisa -> (soxta) Telegram. */
let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let wsUrl: string;
const sent: string[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'x' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      IdentityModule,
      EventsModule,
      AgentModule,
      HealthAlertsModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 3000 })
    .overrideProvider(TelegramService)
    .useValue({ notifyText: async (t: string) => (sent.push(t), 1) })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(MachineHealthService).minIntervalMs = 0;
  wsUrl = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${AGENT_WS_PATH}`;
}, 120_000);
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connect(): Promise<{ ws: WebSocket; machineId: string; send: (type: string, payload: unknown) => void }> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x as string;
  const { code } = await app.get(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-health' }, 'test');
  const res = await request(app.getHttpServer())
    .post('/v1/enroll')
    .send({ code, public_key: pub, hardware_id: `hw-h-${randomBytes(4).toString('hex')}`, hostname: 'zz-health-host', os: 'linux', arch: 'x64' })
    .expect(201);
  const deviceId = res.body.device_id as string;
  const ws = new WebSocket(wsUrl);
  const inbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as { type: string; payload: Record<string, unknown> }));
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  const challenge = await eventually(async () => inbox.find((m) => m.type === 'auth.challenge'), (m) => !!m);
  const nonce = challenge?.payload.nonce as string;
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce, ts, deviceId }), 'utf8'), privateKey as KeyObject).toString('base64url');
  ws.send(JSON.stringify(createEnvelope('auth.response', { deviceId, ts, signature, agentdVersion: '0.1.0-test', hostname: 'zz-health-host', os: 'linux' })));
  await eventually(async () => inbox.find((m) => m.type === 'auth.ok'), (m) => !!m);
  return { ws, machineId: res.body.machine_id as string, send: (type, payload) => ws.send(JSON.stringify(createEnvelope(type, payload))) };
}

const health = (diskPct: number, over: Record<string, unknown> = {}) => ({
  kind: 'full', collectedAt: Date.now(), platform: 'linux', cpu: { pct: 5, cores: 2 },
  memory: { totalBytes: 100, usedBytes: 10, swapTotalBytes: 0, swapUsedBytes: 0 }, uptimeSec: 9,
  disks: [{ mount: '/', totalBytes: 100, usedBytes: diskPct, pct: diskPct }], topProcesses: { byCpu: [], byMem: [] }, ...over,
});

describe('agent.health e2e', () => {
  it('WS -> machine_health + latest; disk 96% = bitta kritik hodisa, bitta Telegram xabari; tiklanganda "Tiklandi"', async () => {
    const a = await connect();
    a.send('agent.health', health(96));
    const rows = await eventually(() => ds.query(`SELECT disk_max_pct FROM machine_health WHERE machine_id = $1`, [a.machineId]), (r: unknown[]) => r.length === 1);
    expect(rows).toHaveLength(1);
    const inc = await eventually(() => ds.query(`SELECT kind, subject, severity, notified_at FROM health_incidents WHERE machine_id = $1`, [a.machineId]), (r: unknown[]) => r.length === 1);
    expect(inc[0]).toMatchObject({ kind: 'disk', subject: '/', severity: 'critical' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('96%');

    // takroriy snapshotlar: yangi xabar yo'q
    await new Promise((r) => setTimeout(r, 15));
    a.send('agent.health', health(97, { kind: 'delta' }));
    await eventually(() => ds.query(`SELECT 1 FROM machine_health WHERE machine_id = $1`, [a.machineId]), (r: unknown[]) => r.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);

    // tiklandi
    await new Promise((r) => setTimeout(r, 15));
    a.send('agent.health', health(40));
    const resolved = await eventually(() => ds.query(`SELECT resolved_at FROM health_incidents WHERE machine_id = $1`, [a.machineId]), (r: Array<{ resolved_at: Date | null }>) => r[0]?.resolved_at !== null);
    expect(resolved[0]?.resolved_at).not.toBeNull();
    await eventually(async () => sent.length, (n) => n === 2);
    expect(sent[1]).toContain('Tiklandi');
    a.ws.close();
  });

  it('yaroqsiz yuk nack oladi; ulanish ochiq qoladi', async () => {
    const a = await connect();
    const nacks: string[] = [];
    a.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { type: string; payload: { code?: string } };
      if (m.type === 'nack') nacks.push(m.payload.code ?? '');
    });
    a.send('agent.health', { kind: 'full', collectedAt: 1 });
    await eventually(async () => nacks.length, (n) => n === 1);
    expect(nacks).toEqual(['invalid_payload']);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.close();
  });
});
