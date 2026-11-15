import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SIGNED_HEADERS, buildCanonicalString } from '@commander/contracts';
import { configureApp } from '../../src/app.setup.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { NoAudit } from '../../src/identity/audit/audit.decorators.js';
import { AuditService } from '../../src/identity/audit/audit.service.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { sha256Hex } from '../../src/identity/common/crypto.util.js';
import { ClientAuth, DeviceAuth } from '../../src/identity/devices/auth.decorators.js';
import { DevicesService } from '../../src/identity/devices/devices.service.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { LockdownService } from '../../src/identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;
const LEGACY = 'legacy-hook-secret';

/** Faqat test uchun: imzolangan/tokenli mutating route'lar (default audit, opt-out, scope). */
@Controller('v1/test')
class TestController {
  @Post('device-echo')
  @DeviceAuth()
  deviceEcho(@Body() body: Record<string, unknown>): { echoed: Record<string, unknown> } {
    return { echoed: body };
  }

  @Post('control')
  @ClientAuth('control')
  control(): { ok: true } {
    return { ok: true };
  }

  @Post('quiet')
  @NoAudit()
  @ClientAuth('read')
  quiet(): { ok: true } {
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

async function createApp(url: string): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: LEGACY })] }),
      TypeOrmModule.forRoot(typeOrmOptions(url, true)),
      IdentityModule,
      ],
    controllers: [TestController],
  }).compile();
  const a = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(a);
  await a.init();
  return a;
}

beforeAll(async () => {
  db = await createThrowawayDb();
  app = await createApp(db.url);
  ds = app.get(DataSource);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

const http = () => app.getHttpServer();
const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const agg = () => svc(FailureAggregator);
let hwCounter = 0;

interface Keys { priv: KeyObject; pubB64: string }
function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
}

async function enrollBody(code: string, keys: Keys, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    code,
    public_key: keys.pubB64,
    hardware_id: `hw-test-${++hwCounter}-${randomBytes(4).toString('hex')}`,
    hostname: 'zz-test-0.6-host',
    os: 'darwin',
    arch: 'arm64',
    ...over,
  };
}

async function enrolled(name = 'zz-test-0.6'): Promise<{ deviceId: string; machineId: string; keys: Keys }> {
  const keys = newKeys();
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await request(http()).post('/v1/enroll').send(await enrollBody(code, keys)).expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys };
}

interface SignOpts { body?: string; ts?: number; nonce?: string; signWith?: KeyObject; tamperPath?: string; tamperBody?: string }
/** agentd mijozining imzolash algoritmi (kanonik satr contracts'dan). */
function signedHeaders(method: string, url: string, deviceId: string, keys: Keys, o: SignOpts = {}): Record<string, string> {
  const [path = '', rawQuery = ''] = url.split('?');
  const timestamp = String(o.ts ?? Date.now());
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const canonical = buildCanonicalString({
    method, path, rawQuery, bodySha256: sha256Hex(Buffer.from(o.body ?? '', 'utf8')), timestamp, nonce, deviceId,
  });
  const signature = sign(null, Buffer.from(canonical), o.signWith ?? keys.priv).toString('base64url');
  return {
    [SIGNED_HEADERS.deviceId]: deviceId,
    [SIGNED_HEADERS.timestamp]: timestamp,
    [SIGNED_HEADERS.nonce]: nonce,
    [SIGNED_HEADERS.signature]: signature,
  };
}

const signedGet = (url: string, id: string, keys: Keys, o: SignOpts = {}) => {
  let r = request(http()).get(o.tamperPath ?? url);
  for (const [k, v] of Object.entries(signedHeaders('GET', url, id, keys, o))) r = r.set(k, v);
  return r;
};
const signedPost = (url: string, id: string, keys: Keys, body: Record<string, unknown>, o: SignOpts = {}) => {
  const raw = JSON.stringify(body);
  let r = request(http()).post(url).set('content-type', 'application/json');
  for (const [k, v] of Object.entries(signedHeaders('POST', url, id, keys, { ...o, body: o.body ?? raw }))) r = r.set(k, v);
  return r.send(o.tamperBody ?? raw);
};

async function issue(scopes: string[], over: { kind?: string; days?: number } = {}) {
  return svc(ClientTokensService).issue({ kind: over.kind ?? 'web', name: 'zz-test-0.6 token', scopes, expiresInDays: over.days }, 'test');
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function auditRows(where = 'TRUE', params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return ds.query(`SELECT id::text AS id, actor_kind, actor_device_id, action, target, details FROM audit_log WHERE ${where} ORDER BY id`, params);
}
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('enrollment', () => {
  it('happy path: code -> machine + device; code is single use; audit rows have no secrets', async () => {
    const keys = newKeys();
    const created = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 happy' }, 'test');
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const stored = await ds.query(`SELECT code_hash FROM enrollment_codes WHERE id = $1`, [created.id]);
    expect(stored[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.code.replace('-', ''));

    const body = await enrollBody(created.code.toLowerCase().replace('-', ' '), keys); // registr/ajratgich e'tiborsiz
    const res = await request(http()).post('/v1/enroll').send(body).expect(201);
    expect(res.body).toEqual({ device_id: expect.any(String), machine_id: expect.any(String), center_public_key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

    const dev = await ds.query(`SELECT kind, machine_id, encode(public_key, 'base64') AS pk, name FROM devices WHERE id = $1`, [res.body.device_id]);
    expect(dev[0]).toMatchObject({ kind: 'agentd', machine_id: res.body.machine_id, name: 'zz-test-0.6 happy' });
    expect(Buffer.from(dev[0].pk, 'base64').toString('base64url')).toBe(keys.pubB64);
    const mach = await ds.query(`SELECT identity_status, hardware_id, display_name FROM machines WHERE id = $1`, [res.body.machine_id]);
    expect(mach[0]).toMatchObject({ identity_status: 'verified', hardware_id: body.hardware_id, display_name: 'zz-test-0.6 happy' });

    // reuse -> 401, same body as a wrong code
    const reuse = await request(http()).post('/v1/enroll').send(await enrollBody(created.code, newKeys())).expect(401);
    const wrong = await request(http()).post('/v1/enroll').send(await enrollBody('ZZZZ-ZZZZ', newKeys())).expect(401);
    expect(reuse.body).toEqual(wrong.body);

    const rows = await auditRows(`action IN ('enrollment_code.created','enrollment_code.used','device.enrolled') AND details::text LIKE '%zz-test-0.6%' OR target = $1`, [created.id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['enrollment_code.created', 'enrollment_code.used', 'device.enrolled']));
    const everything = JSON.stringify(await auditRows());
    expect(everything).not.toContain(created.code);
    expect(everything).not.toContain(created.code.replace('-', ''));
  });

  it('expired code is rejected (401) and stays unused', async () => {
    const { id, code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 expired' }, 'test');
    await ds.query(`UPDATE enrollment_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    await request(http()).post('/v1/enroll').send(await enrollBody(code, newKeys())).expect(401);
    expect((await ds.query(`SELECT used_at FROM enrollment_codes WHERE id = $1`, [id]))[0].used_at).toBeNull();
    const f = await eventually(() => auditRows(`action = 'enrollment_code.failed' AND details->>'reason' = 'expired'`), (r) => r.length > 0);
    expect(f.length).toBeGreaterThan(0);
  });

  it('rejects SPKI/garbage public keys and unknown fields with 400 (no code is consumed)', async () => {
    const { id, code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 badkey' }, 'test');
    const spki = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await request(http()).post('/v1/enroll').send(await enrollBody(code, newKeys(), { public_key: spki })).expect(400);
    await request(http()).post('/v1/enroll').send(await enrollBody(code, newKeys(), { public_key: 'A'.repeat(43) })).expect(400); // all-zero key
    await request(http()).post('/v1/enroll').send(await enrollBody(code, newKeys(), { extra: 1 })).expect(400);
    expect((await ds.query(`SELECT used_at FROM enrollment_codes WHERE id = $1`, [id]))[0].used_at).toBeNull();
  });

  it('links by hardware_id, records (but never applies) a hostname merge candidate, and refuses a second active agentd', async () => {
    const legacy = await ds.query(
      `INSERT INTO machines (slug, hostname, legacy_host, identity_status) VALUES ('zz-legacy-0-6', 'ZZ-Legacy.local', 'ZZ-Legacy.local', 'legacy_unverified') RETURNING id`,
    );
    const keys = newKeys();
    const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 merge' }, 'test');
    const body = await enrollBody(code, keys, { hostname: 'zz-legacy' });
    const res = await request(http()).post('/v1/enroll').send(body).expect(201);
    expect(res.body.machine_id).not.toBe(legacy[0].id);

    const cand = await ds.query(`SELECT machine_id, candidate_machine_id, reason, resolved_at FROM machine_merge_candidates WHERE machine_id = $1`, [res.body.machine_id]);
    expect(cand).toHaveLength(1);
    expect(cand[0]).toMatchObject({ candidate_machine_id: legacy[0].id, reason: 'hostname_match', resolved_at: null });
    const l = await ds.query(`SELECT identity_status, merged_into_id FROM machines WHERE id = $1`, [legacy[0].id]);
    expect(l[0]).toEqual({ identity_status: 'legacy_unverified', merged_into_id: null });
    expect((await auditRows(`action = 'machine.merge_candidate' AND target = $1`, [res.body.machine_id])).length).toBe(1);

    // same hardware_id again while the first device is active -> 409, code not consumed
    const second = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 merge2' }, 'test');
    await request(http()).post('/v1/enroll').send({ ...(await enrollBody(second.code, newKeys())), hardware_id: body.hardware_id }).expect(409);
    expect((await ds.query(`SELECT used_at FROM enrollment_codes WHERE id = $1`, [second.id]))[0].used_at).toBeNull();

    // after revoke the same machine can be re-enrolled and keeps its machine_id
    await svc(DevicesService).revoke(res.body.device_id, 'agentd', 'test');
    const again = await request(http()).post('/v1/enroll').send({ ...(await enrollBody(second.code, newKeys())), hardware_id: body.hardware_id }).expect(201);
    expect(again.body.machine_id).toBe(res.body.machine_id);
  });

  it('rate-limits code guessing (per-IP failures), then even a valid code gets 429', async () => {
    const a = await createApp(db.url); // yangi limiter holati
    try {
      for (let i = 0; i < 5; i++) {
        await request(a.getHttpServer()).post('/v1/enroll').send(await enrollBody(`BAD${i}-BAD${i}`.slice(0, 9), newKeys())).expect(401);
      }
      const { code } = await a.get(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 limited' }, 'test');
      const blocked = await request(a.getHttpServer()).post('/v1/enroll').send(await enrollBody(code, newKeys())).expect(429);
      expect(blocked.body.error).toBe('rate_limited');
      // aggregated audit: 5 failures did not become 5 rows
      a.get(FailureAggregator).flush(Date.now() + 61_000, true);
      const rows = await eventually(() => auditRows(`action = 'enrollment_code.failed' AND details->>'reason' = 'unknown'`), (r) => r.length > 0);
      expect(rows.length).toBeLessThanOrEqual(3);
    } finally {
      await a.close();
    }
  });
});

describe('device request signing', () => {
  let dev: Awaited<ReturnType<typeof enrolled>>;
  beforeAll(async () => {
    dev = await enrolled('zz-test-0.6 signer');
  });

  it('valid signature -> 200 with device identity; unsigned -> 401', async () => {
    const ok = await signedGet('/v1/devices/me', dev.deviceId, dev.keys).expect(200);
    expect(ok.body).toMatchObject({ device_id: dev.deviceId, machine_id: dev.machineId, kind: 'agentd' });
    await request(http()).get('/v1/devices/me').expect(401);
    await request(http()).get('/v1/devices/me').set('Authorization', `Bearer ${LEGACY}`).expect(401); // AUTH_TOKEN /v1'da yaroqsiz
  });

  it('rejects wrong key, tampered path/query/body, malformed headers', async () => {
    const other = newKeys();
    await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { signWith: other.priv }).expect(401);
    // imzo query bilan, so'rov boshqa query bilan
    const h = signedHeaders('GET', '/v1/devices/me?a=1', dev.deviceId, dev.keys);
    let r = request(http()).get('/v1/devices/me?a=2');
    for (const [k, v] of Object.entries(h)) r = r.set(k, v);
    await r.expect(401);
    // query tartibi kanonik: b=1&a=2 va a=2&b=1 ikkalasi ham o'tadi
    const h2 = signedHeaders('GET', '/v1/devices/me?b=1&a=2', dev.deviceId, dev.keys);
    let r2 = request(http()).get('/v1/devices/me?a=2&b=1');
    for (const [k, v] of Object.entries(h2)) r2 = r2.set(k, v);
    await r2.expect(200);
    await signedPost('/v1/test/device-echo', dev.deviceId, dev.keys, { a: 1 }, { tamperBody: JSON.stringify({ a: 2 }) }).expect(401);
    await signedPost('/v1/test/device-echo', dev.deviceId, dev.keys, { a: 1 }).expect(201);
    await request(http()).get('/v1/devices/me').set(SIGNED_HEADERS.deviceId, 'not-a-uuid').set(SIGNED_HEADERS.timestamp, '1').set(SIGNED_HEADERS.nonce, 'x').set(SIGNED_HEADERS.signature, 'y').expect(401);
  });

  it('rejects clock skew over 60 s (both directions) but accepts within it', async () => {
    await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { ts: Date.now() - 61_000 }).expect(401);
    await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { ts: Date.now() + 61_000 }).expect(401);
    await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { ts: Date.now() - 30_000 }).expect(200);
  });

  it('rejects a replayed nonce, also after an app "restart" (nonces live in Postgres)', async () => {
    const nonce = randomBytes(16).toString('base64url');
    const ts = Date.now();
    await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { nonce, ts }).expect(200);
    const replay = await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { nonce, ts }).expect(401);
    expect(replay.body.reason).toBe('replay');

    const restarted = await createApp(db.url);
    try {
      let r = request(restarted.getHttpServer()).get('/v1/devices/me');
      for (const [k, v] of Object.entries(signedHeaders('GET', '/v1/devices/me', dev.deviceId, dev.keys, { nonce, ts }))) r = r.set(k, v);
      expect((await r.expect(401)).body.reason).toBe('replay');
    } finally {
      await restarted.close();
    }
  });

  it('expired nonces are cleaned up', async () => {
    await ds.query(`UPDATE used_nonces SET expires_at = now() - interval '1 second'`);
    await svc(DevicesService); // noop
    await app.get((await import('../../src/identity/devices/device-signature.verifier.js')).DeviceSignatureVerifier).cleanupExpired();
    expect((await ds.query(`SELECT count(*)::int AS n FROM used_nonces WHERE expires_at < now()`))[0].n).toBe(0);
  });

  it('revoked device -> 401 immediately; revoking is audited', async () => {
    const d = await enrolled('zz-test-0.6 revoked');
    await signedGet('/v1/devices/me', d.deviceId, d.keys).expect(200);
    await svc(DevicesService).revoke(d.deviceId, 'agentd', 'test');
    const res = await signedGet('/v1/devices/me', d.deviceId, d.keys).expect(401);
    expect(res.body.reason).toBe('device_revoked');
    expect((await auditRows(`action = 'device.revoked' AND target = $1`, [d.deviceId])).length).toBe(1);
    await expect(svc(DevicesService).revoke(d.deviceId, 'agentd', 'test')).rejects.toThrow(/already revoked/);
  });

  it('a failure flood is rate-limited and aggregated in audit (no table bloat), without secrets', async () => {
    const before = (await auditRows(`action = 'auth.failed'`)).length;
    const wrong = newKeys();
    for (let i = 0; i < 40; i++) await signedGet('/v1/devices/me', dev.deviceId, dev.keys, { signWith: wrong.priv }).expect(401);
    agg().flush(Date.now() + 61_000, true);
    const rows = await eventually(() => auditRows(`action = 'auth.failed'`), (r) => r.length > before);
    const mine = rows.slice(before);
    expect(mine.length).toBeLessThanOrEqual(3);
    expect(mine.reduce((n, r) => n + Number((r.details as { count: number }).count), 0)).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/x-signature|signature":"[A-Za-z0-9_-]{40,}/i);
  });
});

describe('client tokens', () => {
  it('L-23: new tokens expire in 90 days by default; no expiry only with an explicit neverExpires', async () => {
    const def = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-def-${randomBytes(2).toString('hex')}`, scopes: ['read'] }, 'test');
    expect(def.expires_at).not.toBeNull();
    const days = (new Date(def.expires_at as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90.01);
    const never = await svc(ClientTokensService).issue({ kind: 'web', name: `zz-never-${randomBytes(2).toString('hex')}`, scopes: ['read'], neverExpires: true }, 'test');
    expect(never.expires_at).toBeNull();
    await expect(svc(ClientTokensService).issue({ kind: 'web', name: 'zz-x', scopes: ['read'], neverExpires: true, expiresInDays: 5 }, 'test')).rejects.toThrow(/mutually exclusive/);
  });

  it('token is opaque, stored as SHA-256, scoped, and first use is audited exactly once', async () => {
    const t = await issue(['read']);
    expect(t.token).toMatch(/^cmdr_[A-Za-z0-9_-]{43}$/);
    const row = await ds.query(`SELECT token_hash, scopes, kind FROM devices WHERE id = $1`, [t.id]);
    expect(row[0].token_hash).toBe(sha256Hex(t.token));
    expect(row[0].scopes).toEqual(['read']);

    for (let i = 0; i < 3; i++) await request(http()).get('/v1/test/read').set(bearer(t.token)).expect(200);
    const first = await eventually(() => auditRows(`action = 'token.first_used' AND target = $1`, [t.id]), (r) => r.length > 0);
    expect(first).toHaveLength(1);
    expect((await ds.query(`SELECT last_used_at FROM devices WHERE id = $1`, [t.id]))[0].last_used_at).not.toBeNull();
    expect(JSON.stringify(await auditRows())).not.toContain(t.token);
    expect((await auditRows(`action = 'token.issued' AND target = $1`, [t.id])).length).toBe(1);
  });

  it('enforces scopes (flat; admin covers all) and rejects bad/expired/revoked tokens', async () => {
    const read = await issue(['read']);
    const control = await issue(['control']);
    const admin = await issue(['admin']);
    await request(http()).post('/v1/test/control').set(bearer(read.token)).expect(403);
    await request(http()).post('/v1/test/control').set(bearer(control.token)).expect(201);
    await request(http()).post('/v1/test/control').set(bearer(admin.token)).expect(201);
    await request(http()).get('/v1/test/read').set(bearer(control.token)).expect(403); // control read'ni qamramaydi
    await request(http()).get('/v1/audit').set(bearer(read.token)).expect(403);
    await request(http()).get('/v1/audit').set(bearer(admin.token)).expect(200);

    await request(http()).get('/v1/test/read').expect(401);
    await request(http()).get('/v1/test/read').set(bearer('cmdr_' + 'x'.repeat(43))).expect(401);
    await request(http()).get('/v1/test/read').set(bearer(LEGACY)).expect(401);

    const expiring = await issue(['read'], { days: 1 });
    await request(http()).get('/v1/test/read').set(bearer(expiring.token)).expect(200);
    await ds.query(`UPDATE devices SET expires_at = now() - interval '1 second' WHERE id = $1`, [expiring.id]);
    await request(http()).get('/v1/test/read').set(bearer(expiring.token)).expect(401);

    await svc(DevicesService).revoke(read.id, 'client', 'test');
    await request(http()).get('/v1/test/read').set(bearer(read.token)).expect(401);
    expect((await auditRows(`action = 'token.revoked' AND target = $1`, [read.id])).length).toBe(1);
    await expect(svc(DevicesService).revoke(admin.id, 'agentd', 'test')).rejects.toThrow(/use the token command/);
    await expect(svc(ClientTokensService).issue({ kind: 'web', name: 'x', scopes: ['root'] }, 'test')).rejects.toThrow(/scopes/);
  });

  it('M-10: legacy GET /sessions is gone; AUTH_TOKEN is accepted nowhere', async () => {
    const read = await issue(['read']);
    await request(http()).get('/sessions').set(bearer(LEGACY)).expect(404);
    await request(http()).get('/sessions').set(bearer(read.token)).expect(404);
    await request(http()).get('/v1/audit').set(bearer(LEGACY)).expect(401);
  });
});

describe('lockdown', () => {
  it('on: device-signed and client mutating requests and enrollment are rejected; reads pass; off restores', async () => {
    const dev = await enrolled('zz-test-0.6 lockdown');
    const ctl = await issue(['control']);
    const reader = await issue(['read']);
    const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: 'zz-test-0.6 locked-enroll' }, 'test');

    await svc(LockdownService).set(true, 'test');
    try {
      expect(await svc(LockdownService).state()).toMatchObject({ enabled: true });
      await signedPost('/v1/test/device-echo', dev.deviceId, dev.keys, { a: 1 }).expect(403);
      await request(http()).post('/v1/test/control').set(bearer(ctl.token)).expect(403);
      await request(http()).post('/v1/enroll').send(await enrollBody(code, newKeys())).expect(403);
      // o'qish ruxsat
      await signedGet('/v1/devices/me', dev.deviceId, dev.keys).expect(200);
      await request(http()).get('/v1/test/read').set(bearer(reader.token)).expect(200);
      // lockdown tufayli rad etish ham audit qilinadi (aggregatsiya)
      agg().flush(Date.now() + 61_000, true);
      const rej = await eventually(() => auditRows(`action = 'lockdown.rejected'`), (r) => r.length > 0);
      expect(rej.length).toBeGreaterThan(0);
    } finally {
      await svc(LockdownService).set(false, 'test');
    }
    await signedPost('/v1/test/device-echo', dev.deviceId, dev.keys, { a: 1 }).expect(201);
    await request(http()).post('/v1/test/control').set(bearer(ctl.token)).expect(201);
    const changes = await auditRows(`action = 'lockdown.changed'`);
    expect(changes.map((c) => (c.details as { enabled: boolean }).enabled)).toEqual([true, false]);
  });

  it('is persisted in the database (a fresh app instance sees it)', async () => {
    await svc(LockdownService).set(true, 'test');
    const other = await createApp(db.url);
    try {
      expect(await other.get(LockdownService).state()).toMatchObject({ enabled: true });
    } finally {
      await other.close();
      await svc(LockdownService).set(false, 'test');
    }
  });
});

describe('audit', () => {
  it('mutating /v1 routes are audited by default (before the handler); @NoAudit opts out; reads are not audited', async () => {
    const dev = await enrolled('zz-test-0.6 audit');
    const t = await issue(['control', 'read']);
    const marker = async (action: string) => (await auditRows(`action = $1`, [action])).length;
    const before = await marker('POST /v1/test/control');
    await request(http()).post('/v1/test/control').set(bearer(t.token)).expect(201);
    await signedPost('/v1/test/device-echo', dev.deviceId, dev.keys, { password: 'hunter2', note: 'hello' }).expect(201);
    expect(await marker('POST /v1/test/control')).toBe(before + 1);
    const echo = await auditRows(`action = 'POST /v1/test/device-echo' AND actor_device_id = $1`, [dev.deviceId]);
    expect(echo).toHaveLength(1);
    expect(echo[0]).toMatchObject({ actor_kind: 'agentd', details: { method: 'POST', route: '/v1/test/device-echo', phase: 'request' } });
    expect(JSON.stringify(echo)).not.toContain('hunter2'); // tana auditga tushmaydi

    const quietBefore = await marker('POST /v1/test/quiet');
    await request(http()).post('/v1/test/quiet').set(bearer(t.token)).expect(201);
    expect(await marker('POST /v1/test/quiet')).toBe(quietBefore);
    const readsBefore = await marker('GET /v1/test/read');
    await request(http()).get('/v1/test/read').set(bearer(t.token)).expect(200);
    expect(await marker('GET /v1/test/read')).toBe(readsBefore);
  });

  it('audit rows never contain tokens, enrollment codes or signatures (full-table scan)', async () => {
    const t = await issue(['admin']);
    await request(http()).get('/v1/audit?limit=5').set(bearer(t.token)).expect(200);
    const all = JSON.stringify(await auditRows());
    expect(all).not.toMatch(/cmdr_[A-Za-z0-9_-]{20,}/);
    expect(all).not.toMatch(/Bearer\s/);
    expect(all).not.toContain(LEGACY);
  });

  it('GET /v1/audit paginates (newest first) and filters by action', async () => {
    const t = await issue(['admin']);
    await request(http()).get('/v1/audit?limit=1').set(bearer(t.token)).expect(200); // token.first_used qatori shu yerda yoziladi
    const total = Number((await ds.query(`SELECT count(*) AS n FROM audit_log`))[0].n);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 500; guard++) {
      const res = await request(http()).get('/v1/audit').query({ limit: 7, ...(before ? { before } : {}) }).set(bearer(t.token)).expect(200);
      const items = res.body.items as Array<{ id: string; hash: string; prev_hash: string | null }>;
      expect(items.length).toBeLessThanOrEqual(7);
      seen.push(...items.map((i) => i.id));
      before = res.body.next_before as string | undefined;
      if (!before) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total);
    expect(seen.map(Number)).toEqual([...seen.map(Number)].sort((a, b) => b - a));

    const only = await request(http()).get('/v1/audit?action=lockdown.changed').set(bearer(t.token)).expect(200);
    expect(only.body.items.every((i: { action: string }) => i.action === 'lockdown.changed')).toBe(true);
    await request(http()).get('/v1/audit?limit=0').set(bearer(t.token)).expect(400);
    await request(http()).get('/v1/audit?bogus=1').set(bearer(t.token)).expect(400);
  });

  it('hash chain is computed by the DB trigger (app never supplies hashes) and verify=1 finds the first broken link', async () => {
    const t = await issue(['admin']);
    const ok = await request(http()).get('/v1/audit?verify=1').set(bearer(t.token)).expect(200);
    expect(ok.body).toMatchObject({ ok: true, first_broken_id: null });

    await svc(AuditService).record({ actorKind: 'system', action: 'zz.victim', details: { n: 1 } });
    await svc(AuditService).record({ actorKind: 'system', action: 'zz.after', details: { n: 2 } });
    const victim = (await auditRows(`action = 'zz.victim'`))[0]!;
    const rows = await ds.query(`SELECT prev_hash, hash FROM audit_log WHERE id::text = $1`, [victim.id]);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);

    await ds.query(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_update_delete`);
    try {
      await ds.query(`UPDATE audit_log SET details = '{"n": 99}'::jsonb WHERE id::text = $1`, [victim.id]);
      const bad = await request(http()).get('/v1/audit?verify=1').set(bearer(t.token)).expect(200);
      expect(bad.body.ok).toBe(false);
      expect(bad.body.first_broken_id).toBe(victim.id);
    } finally {
      await ds.query(`UPDATE audit_log SET details = '{"n": 1}'::jsonb WHERE id::text = $1`, [victim.id]);
      await ds.query(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_update_delete`);
    }
    const healed = await request(http()).get('/v1/audit?verify=1').set(bearer(t.token)).expect(200);
    expect(healed.body.ok).toBe(true);
  });
});
