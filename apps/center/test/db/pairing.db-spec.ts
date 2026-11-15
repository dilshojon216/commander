import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { CLIENT_WS_CLOSE, CLIENT_WS_PATH, SIGNED_HEADERS, buildCanonicalString, buildClientSubprotocols } from '@commander/contracts';
import { isStepUpExemptDevice } from '../../src/approvals/step-up-exempt.js';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { AuditService } from '../../src/identity/audit/audit.service.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { sha256Hex } from '../../src/identity/common/crypto.util.js';
import { FixedWindowLimiter } from '../../src/identity/common/rate-limiter.js';
import { PAIR_FAIL_GLOBAL_LIMIT, PAIR_FAIL_IP_LIMIT, PAIR_FAIL_WINDOW_MS, SecurityEvents } from '../../src/identity/common/security-events.service.js';
import { ClientAuth } from '../../src/identity/devices/auth.decorators.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { PairingService } from '../../src/identity/pairing/pairing.service.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

@Controller('v1/test')
class TestController {
  @Post('control')
  @ClientAuth('control')
  control(): { ok: true } {
    return { ok: true };
  }

  @Get('read')
  @ClientAuth('read')
  read(): { ok: true } {
    return { ok: true };
  }
}

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({})] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      RealtimeModule,
    ],
    controllers: [TestController],
  })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 100, usageTickMs: 300, authTimeoutMs: 600 })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  port = (app.getHttpServer().address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await db.drop();
});

const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());

/** Limitlar bitta peer (127.0.0.1) bo'yicha umumiy: har testdan oldin tozalanadi. */
beforeEach(() => {
  const ev = svc(SecurityEvents) as unknown as Record<string, FixedWindowLimiter>;
  ev.pairFailuresByIp = new FixedWindowLimiter(PAIR_FAIL_IP_LIMIT, PAIR_FAIL_WINDOW_MS);
  ev.pairFailuresGlobal = new FixedWindowLimiter(PAIR_FAIL_GLOBAL_LIMIT, PAIR_FAIL_WINDOW_MS);
});

const mkCode = (over: Partial<{ kind: string; name: string; scopes: string[]; ttlMinutes: number; expiresDays: number }> = {}) =>
  svc(PairingService).createCode({ kind: 'mobile', name: 'iPhone', scopes: ['read', 'approve'], ...over }, 'test');
const pairBody = (code: string, over: Record<string, unknown> = {}) => ({ code, deviceName: 'Test iPhone', platform: 'ios', ...over });
const pair = (code: string, over: Record<string, unknown> = {}) => http().post('/v1/clients/pair').send(pairBody(code, over));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('code lifecycle', () => {
  it('create -> pair -> token works on a read route and GET /v1/devices/me (camelCase)', async () => {
    const created = await mkCode({ kind: 'menubar', scopes: ['read', 'approve'], expiresDays: 30 });
    expect(created.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const res = await pair(created.code.toLowerCase().replace('-', ' '), { deviceName: 'MBP menubar', platform: 'macos' }).expect(201);
    expect(res.body).toMatchObject({ kind: 'menubar', name: 'MBP menubar', scopes: ['read', 'approve'] });
    expect(res.body.token).toMatch(/^cmdr_[A-Za-z0-9_-]{43}$/);
    const days = (new Date(res.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    await http().get('/v1/test/read').set(bearer(res.body.token)).expect(200);
    const me = await http().get('/v1/devices/me').set(bearer(res.body.token)).expect(200);
    expect(me.body).toMatchObject({
      deviceId: res.body.deviceId, kind: 'menubar', name: 'MBP menubar', platform: 'macos', scopes: ['read', 'approve'], stepUpExempt: false,
    });
    expect(me.body.serverTime).toEqual(expect.any(String));

    // token DB'da faqat xesh; kod ham xesh
    const [dev] = await ds.query(`SELECT token_hash, platform FROM devices WHERE id = $1`, [res.body.deviceId]);
    expect(dev.token_hash).toBe(sha256Hex(res.body.token));
    expect(dev.platform).toBe('macos');
    const [row] = await ds.query(`SELECT code_hash, used_at, used_by_device_id FROM client_pairing_codes WHERE id = $1`, [created.id]);
    expect(row.code_hash).not.toContain(created.code);
    expect(row.used_by_device_id).toBe(res.body.deviceId);
    expect(row.used_at).not.toBeNull();
  });

  it('replay: a used code is rejected with the same uniform 401, no second device', async () => {
    const { code } = await mkCode();
    await pair(code).expect(201);
    const before = await ds.query(`SELECT count(*)::int AS n FROM devices`);
    const again = await pair(code).expect(401);
    expect(again.body).toMatchObject({ error: 'invalid_pairing_code' });
    expect((await ds.query(`SELECT count(*)::int AS n FROM devices`))[0].n).toBe(before[0].n);
    const unknown = await pair('ZZZZZ-ZZZZZ').expect(401);
    expect(unknown.body).toEqual(again.body);
  });

  it('TTL: an expired code is rejected and not consumed', async () => {
    const c = await mkCode({ ttlMinutes: 1 });
    await ds.query(`UPDATE client_pairing_codes SET expires_at = now() - interval '1 second' WHERE id = $1`, [c.id]);
    await pair(c.code).expect(401);
    const [row] = await ds.query(`SELECT used_at FROM client_pairing_codes WHERE id = $1`, [c.id]);
    expect(row.used_at).toBeNull();
    const actions = await ds.query(`SELECT details FROM audit_log WHERE action = 'pairing_code.failed' AND target = $1`, [c.id]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].details.reason).toBe('expired');
  });

  it('TTL/args validation: ttl 1-60, scopes, kind', async () => {
    const s = svc(PairingService);
    await expect(s.createCode({ kind: 'mobile', name: 'x', scopes: ['read'], ttlMinutes: 61 }, 't')).rejects.toThrow(/ttl-minutes/);
    await expect(s.createCode({ kind: 'mobile', name: 'x', scopes: ['read'], ttlMinutes: 0 }, 't')).rejects.toThrow(/ttl-minutes/);
    await expect(s.createCode({ kind: 'web', name: 'x', scopes: ['read'] }, 't')).rejects.toThrow(/kind/);
    await expect(s.createCode({ kind: 'mobile', name: '', scopes: ['read'] }, 't')).rejects.toThrow(/name/);
  });

  it('concurrent double-use: exactly one wins, one device row', async () => {
    const { code } = await mkCode();
    const before = (await ds.query(`SELECT count(*)::int AS n FROM devices`))[0].n as number;
    const results = await Promise.all(Array.from({ length: 4 }, () => pair(code)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 401, 401, 401]);
    expect((await ds.query(`SELECT count(*)::int AS n FROM devices`))[0].n).toBe(before + 1);
  });

  it('invalid body: strict validation (extra keys, admin scope smuggling, bad publicKey) -> 400, code untouched', async () => {
    const { code, id } = await mkCode();
    await pair(code, { scopes: ['admin'] }).expect(400);
    await pair(code, { publicKey: 'nope' }).expect(400);
    await http().post('/v1/clients/pair').send({ code }).expect(400);
    const [row] = await ds.query(`SELECT used_at FROM client_pairing_codes WHERE id = $1`, [id]);
    expect(row.used_at).toBeNull();
  });

  it('optional publicKey is stored; reusing the same key with another code -> 409 and the code is NOT consumed', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const x = publicKey.export({ format: 'jwk' }).x as string;
    const c1 = await mkCode();
    await pair(c1.code, { publicKey: x }).expect(201);
    const c2 = await mkCode();
    await pair(c2.code, { publicKey: x }).expect(409);
    const [row] = await ds.query(`SELECT used_at FROM client_pairing_codes WHERE id = $1`, [c2.id]);
    expect(row.used_at).toBeNull();
    await pair(c2.code).expect(201);
  });
});

describe('rate limit', () => {
  it('5 wrong codes from one peer, then even the correct code is 429 (and stays unconsumed)', async () => {
    const { code, id } = await mkCode();
    for (let i = 0; i < PAIR_FAIL_IP_LIMIT; i++) await pair(`BAD0${i}-BAD0${i}`).expect(401);
    const blocked = await pair(code).expect(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited' });
    const [row] = await ds.query(`SELECT used_at FROM client_pairing_codes WHERE id = $1`, [id]);
    expect(row.used_at).toBeNull();
  });

  it('global failure budget (10) blocks other peers too', async () => {
    const ev = svc(SecurityEvents);
    for (let i = 0; i < PAIR_FAIL_GLOBAL_LIMIT; i++) ev.pairFailuresGlobal.hit('global');
    const { code } = await mkCode();
    await pair(code).expect(429);
  });
});

describe('scopes', () => {
  it('read-only token: read route 200, control route 403; control only when requested at creation; admin never', async () => {
    const ro = (await pair((await mkCode({ scopes: ['read'] })).code).expect(201)).body;
    await http().get('/v1/test/read').set(bearer(ro.token)).expect(200);
    await http().post('/v1/test/control').set(bearer(ro.token)).expect(403);

    const ctl = (await pair((await mkCode({ scopes: ['read', 'control'] })).code).expect(201)).body;
    expect(ctl.scopes).toEqual(['read', 'control']);
    await http().post('/v1/test/control').set(bearer(ctl.token)).expect(201);

    await expect(mkCode({ scopes: ['read', 'admin'] })).rejects.toThrow(/admin cannot be paired/);
    await expect(ds.query(`INSERT INTO client_pairing_codes (code_hash, kind, name, scopes, expires_at) VALUES ('h-admin','mobile','x','{admin}', now() + interval '1 hour')`)).rejects.toThrow(
      /chk_client_pairing_codes_scopes/,
    );
  });

  it('a paired control device is NOT step-up exempt (only the owner-managed settings list exempts)', async () => {
    const ctl = (await pair((await mkCode({ scopes: ['read', 'control'] })).code).expect(201)).body;
    expect(await isStepUpExemptDevice(ds, ctl.deviceId)).toBe(false);
    expect((await http().get('/v1/devices/me').set(bearer(ctl.token))).body.stepUpExempt).toBe(false);
    // pairing hech qachon settings'ga yozmaydi
    const rows = await ds.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    expect(JSON.stringify(rows)).not.toContain(ctl.deviceId);
    // faqat egasi qo'shsa istisno bo'ladi
    await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify([ctl.deviceId])]);
    expect((await http().get('/v1/devices/me').set(bearer(ctl.token))).body.stepUpExempt).toBe(true);
    await ds.query(`DELETE FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
  });
});

describe('audit', () => {
  it('created/used/paired rows exist, linked to the device, and contain neither the code nor the token', async () => {
    const c = await mkCode({ name: 'audit-check' });
    const res = await pair(c.code, { deviceName: 'Audit iPhone' }).expect(201);
    const rows: Array<{ action: string; actor_device_id: string | null; actor_kind: string; target: string; details: unknown }> = await ds.query(
      `SELECT action, actor_device_id, actor_kind, target, details FROM audit_log
        WHERE action IN ('pairing_code.created','pairing_code.used','device.paired') AND (target = $1 OR target = $2)`,
      [c.id, res.body.deviceId],
    );
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(byAction['pairing_code.created']).toBeDefined();
    expect(byAction['pairing_code.used']).toBeDefined();
    expect(byAction['device.paired']).toMatchObject({ actor_device_id: res.body.deviceId, actor_kind: 'mobile' });
    const dump = JSON.stringify(await ds.query(`SELECT * FROM audit_log`));
    const raw = c.code.replace('-', '');
    expect(dump).not.toContain(res.body.token);
    expect(dump).not.toContain(c.code);
    expect(dump).not.toContain(raw);
    expect((await svc(AuditService).verify()).ok).toBe(true);
  });
});

describe('lockdown', () => {
  it('blocks pairing (403) without consuming the code; works again after lockdown off', async () => {
    const { code, id } = await mkCode();
    await svc(LockdownService).set(true, 'test');
    try {
      const r = await pair(code).expect(403);
      expect(r.body.error).toBeDefined();
      const [row] = await ds.query(`SELECT used_at FROM client_pairing_codes WHERE id = $1`, [id]);
      expect(row.used_at).toBeNull();
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    await pair(code).expect(201);
  });
});

describe('self-revoke', () => {
  function openClientSocket(token: string): { ws: WebSocket; msgs: Array<{ type: string; payload: Record<string, unknown> }>; closed: Promise<number>; opened: Promise<void> } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${CLIENT_WS_PATH}`, buildClientSubprotocols(token));
    sockets.push(ws);
    const msgs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    return {
      ws,
      msgs,
      closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
      opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    };
  }

  it('POST /v1/devices/me/revoke: token dies on REST (401) and on /ws/client; open socket is closed 4010; audited with the device as actor', async () => {
    const c = (await pair((await mkCode({ scopes: ['read'] })).code).expect(201)).body;
    await http().get('/v1/test/read').set(bearer(c.token)).expect(200);

    const live = openClientSocket(c.token);
    await live.opened;
    await eventually(() => live.msgs.some((m) => m.type === 'auth.ok'));

    const r = await http().post('/v1/devices/me/revoke').set(bearer(c.token)).expect(200);
    expect(r.body).toEqual({ revoked: true, deviceId: c.deviceId });
    expect(await live.closed).toBe(CLIENT_WS_CLOSE.revoked);

    await http().get('/v1/test/read').set(bearer(c.token)).expect(401);
    await http().get('/v1/devices/me').set(bearer(c.token)).expect(401);
    await http().post('/v1/devices/me/revoke').set(bearer(c.token)).expect(401);

    const fresh = openClientSocket(c.token);
    await fresh.opened;
    expect(await fresh.closed).toBe(CLIENT_WS_CLOSE.authFailed);
    expect(fresh.msgs.find((m) => m.type === 'auth.error')?.payload.code).toBe('unauthorized');

    const [a] = await ds.query(`SELECT actor_device_id, actor_kind, details FROM audit_log WHERE action = 'token.revoked' AND target = $1`, [c.deviceId]);
    expect(a.actor_device_id).toBe(c.deviceId);
    expect(a.actor_kind).toBe('mobile');
    expect(String(a.details.via)).toMatch(/^self:/);
  });

  it('self-revoke works during lockdown (fail-safe); no token -> 401', async () => {
    const c = (await pair((await mkCode({ scopes: ['read'] })).code).expect(201)).body;
    await svc(LockdownService).set(true, 'test');
    try {
      await http().post('/v1/devices/me/revoke').set(bearer(c.token)).expect(200);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    await http().post('/v1/devices/me/revoke').expect(401);
  });

  it('a token with no scope needed: approve-only device can still call /v1/devices/me', async () => {
    const c = (await pair((await mkCode({ scopes: ['approve'] })).code).expect(201)).body;
    const me = await http().get('/v1/devices/me').set(bearer(c.token)).expect(200);
    expect(me.body.scopes).toEqual(['approve']);
  });
});

describe('agentd signed /v1/devices/me is unchanged', () => {
  it('signature auth still returns the snake_case shape; bearer + garbage rejected', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ format: 'jwk' }).x as string;
    const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-pairing' }, 'test');
    const enr = await http()
      .post('/v1/enroll')
      .send({ code, public_key: pub, hardware_id: `hw-pair-${randomBytes(4).toString('hex')}`, hostname: 'zz-pair-host', os: 'darwin', arch: 'arm64' })
      .expect(201);
    const url = '/v1/devices/me';
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const sig = sign(null, Buffer.from(buildCanonicalString({ method: 'GET', path: url, rawQuery: '', bodySha256: sha256Hex(Buffer.alloc(0)), timestamp: ts, nonce, deviceId: enr.body.device_id })), privateKey as KeyObject).toString('base64url');
    const res = await http()
      .get(url)
      .set({ [SIGNED_HEADERS.deviceId]: enr.body.device_id, [SIGNED_HEADERS.timestamp]: ts, [SIGNED_HEADERS.nonce]: nonce, [SIGNED_HEADERS.signature]: sig })
      .expect(200);
    expect(res.body).toMatchObject({ device_id: enr.body.device_id, kind: 'agentd', machine_id: enr.body.machine_id });
    await http().get(url).expect(401);
    await http().get(url).set(bearer('cmdr_notarealtoken')).expect(401);
  });
});

async function eventually(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(25);
  expect(fn()).toBe(true);
}
