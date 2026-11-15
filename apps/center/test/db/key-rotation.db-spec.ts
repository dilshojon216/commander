import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import {
  AGENT_WS_CLOSE,
  AGENT_WS_PATH,
  CLIENT_WS_CLOSE,
  CLIENT_WS_PATH,
  buildAgentAuthString,
  buildCenterKeyRotationString,
  buildClientSubprotocols,
  buildKeyRotationString,
  createEnvelope,
} from '@commander/contracts';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from '../../src/agent/agent-channel.options.js';
import { AgentModule } from '../../src/agent/agent.module.js';
import { ApiModule } from '../../src/api/api.module.js';
import { ApprovalsModule } from '../../src/approvals/approvals.module.js';
import { APPROVALS_OPTIONS } from '../../src/approvals/approvals.options.js';
import { configureApp } from '../../src/app.setup.js';
import { rotateSignerKeyFile } from '../../src/commands/center-key-rotation.js';
import { CommandSignerService } from '../../src/commands/command-signer.service.js';
import { COMMANDS_OPTIONS, DEFAULT_COMMANDS_OPTIONS } from '../../src/commands/commands.options.js';
import { typeOrmOptions } from '../../src/database/database.config.js';
import { EventsModule } from '../../src/events/events.module.js';
import { CenterKeyAdminService } from '../../src/identity/center-key-admin.service.js';
import { FailureAggregator } from '../../src/identity/audit/failure-aggregator.js';
import { notifyDeviceEvent } from '../../src/identity/devices/device-events.js';
import { DeviceKeysService } from '../../src/identity/devices/device-keys.service.js';
import { DeviceSignatureVerifier, SignatureError } from '../../src/identity/devices/device-signature.verifier.js';
import { DevicesService } from '../../src/identity/devices/devices.service.js';
import { EnrollmentService } from '../../src/identity/enrollment/enrollment.service.js';
import { IdentityModule } from '../../src/identity/identity.module.js';
import { ClientTokensService } from '../../src/identity/tokens/client-tokens.service.js';
import { LimitsModule } from '../../src/limits/limits.module.js';
import { CLIENT_HUB_OPTIONS } from '../../src/realtime/client-hub.options.js';
import { CoreModule } from '../../src/realtime/core.module.js';
import { DeviceEventsListener } from '../../src/realtime/device-events.listener.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { createThrowawayDb } from './helpers.js';

delete process.env.AUTH_TOKEN;

/**
 * 5.1: kalit aylantirish va darhol revoke (haqiqiy TimescaleDB + haqiqiy ws + Ed25519).
 * Sweep'lar ATAYLAB juda sekin (10 daqiqa): ulanish faqat LISTEN/NOTIFY orqali (4010) darhol uzilishi mumkin.
 */

interface Msg { type: string; id: string; payload: Record<string, unknown> }
interface Sock {
  ws: WebSocket;
  nextOf: (type: string, ms?: number) => Promise<Msg>;
  send: (m: unknown) => void;
  closed: Promise<number>;
  opened: Promise<void>;
  all: Msg[];
}
interface Keys { priv: KeyObject; pubB64: string }
interface Enrolled { deviceId: string; machineId: string; keys: Keys }

let db: { url: string; drop: () => Promise<void> };
let app: NestExpressApplication;
let ds: DataSource;
let port: number;
let hw = 0;
let keyDir: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  db = await createThrowawayDb();
  keyDir = mkdtempSync(join(tmpdir(), 'cmdr-keyrot-'));
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => ({ AUTH_TOKEN: 'legacy' })] }),
      TypeOrmModule.forRoot(typeOrmOptions(db.url, true)),
      CoreModule,
      IdentityModule,
      EventsModule,
      ApprovalsModule,
      LimitsModule,
      ApiModule,
      AgentModule,
      RealtimeModule,
    ],
  })
    .overrideProvider(AGENT_CHANNEL_OPTIONS)
    .useValue({ ...DEFAULT_AGENT_CHANNEL_OPTIONS, authTimeoutMs: 1500, heartbeatTimeoutMs: 60_000, revokeCheckIntervalMs: 600_000 })
    .overrideProvider(CLIENT_HUB_OPTIONS)
    .useValue({ sweepMs: 600_000, usageTickMs: 300, authTimeoutMs: 600 })
    .overrideProvider(APPROVALS_OPTIONS)
    .useValue({ sweepMs: 3_600_000 })
    .overrideProvider(COMMANDS_OPTIONS)
    .useValue({ ...DEFAULT_COMMANDS_OPTIONS, keyFile: join(keyDir, 'command-signing.key') })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  ds = app.get(DataSource);
  app.get(FailureAggregator).configure({ maxRowsPerWindow: 1000 });
  port = (app.getHttpServer().address() as AddressInfo).port;
  await app.get(DeviceEventsListener).ready(); // LISTEN tayyor bo'lsin
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await app.close();
  await db.drop();
  rmSync(keyDir, { recursive: true, force: true });
});


const svc = <T>(t: new (...a: never[]) => T): T => app.get(t);
const http = () => request(app.getHttpServer());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openSocket(path: string, protocols?: string[]): Sock {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols);
  sockets.push(ws);
  const inbox: Msg[] = [];
  const all: Msg[] = [];
  const waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    all.push(m);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    all,
    send: (m) => ws.send(JSON.stringify(m)),
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    opened: new Promise((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); }),
    nextOf: (type, ms = 3000) =>
      new Promise((resolve, reject) => {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
  };
}

const newKeys = (): Keys => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey, pubB64: publicKey.export({ format: 'jwk' }).x as string };
};

async function enroll(name = 'zz-5.1'): Promise<Enrolled> {
  const keys = newKeys();
  const { code } = await svc(EnrollmentService).createCode({ kind: 'agentd', machineName: name }, 'test');
  const res = await http()
    .post('/v1/enroll')
    .send({ code, public_key: keys.pubB64, hardware_id: `hw-5.1-${++hw}-${randomBytes(4).toString('hex')}`, hostname: `${name}-host`, os: 'linux', arch: 'x64' })
    .expect(201);
  return { deviceId: res.body.device_id as string, machineId: res.body.machine_id as string, keys };
}

interface Connected extends Sock { enrolled: Enrolled; authOk: Msg }

async function connectAgent(e: Enrolled, extra: Record<string, unknown> = {}): Promise<Connected> {
  const c = openSocket(AGENT_WS_PATH);
  await c.opened;
  const ch = await c.nextOf('auth.challenge');
  const ts = Date.now();
  const signature = sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url');
  c.send(createEnvelope('auth.response', { deviceId: e.deviceId, ts, signature, agentdVersion: '0.1.0-test', hostname: 'zz-host', os: 'linux', ...extra }));
  const authOk = await c.nextOf('auth.ok');
  return { ...c, enrolled: e, authOk };
}

/** Eski va yangi kalit bilan imzolangan `key.rotate` yuki. */
function rotationEnvelope(e: Enrolled, newKeys_: Keys, over: { ts?: number; badNew?: boolean; badOld?: boolean } = {}) {
  const ts = over.ts ?? Date.now();
  const canonical = Buffer.from(buildKeyRotationString({ deviceId: e.deviceId, oldPublicKey: e.keys.pubB64, newPublicKey: newKeys_.pubB64, ts }), 'utf8');
  const other = newKeys().priv;
  return createEnvelope('key.rotate', {
    newPublicKey: newKeys_.pubB64,
    ts,
    oldSignature: sign(null, canonical, over.badOld ? other : e.keys.priv).toString('base64url'),
    newSignature: sign(null, canonical, over.badNew ? other : newKeys_.priv).toString('base64url'),
  });
}

const publicKeyOf = async (deviceId: string): Promise<string> => {
  const rows: Array<{ public_key: Buffer }> = await ds.query(`SELECT public_key FROM devices WHERE id = $1`, [deviceId]);
  return rows[0]!.public_key.toString('base64url');
};

const auditActions = async (action: string, target?: string): Promise<Array<{ details: Record<string, unknown> }>> =>
  ds.query(`SELECT details FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR target = $2) ORDER BY id`, [action, target ?? null]);

describe('device key rotation over the authenticated /ws/agent', () => {
  it('swaps the key atomically, audits it, rejects the old key afterwards and accepts the new one', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const fresh = newKeys();
    const env = rotationEnvelope(e, fresh);
    a.send(env);
    const res = await a.nextOf('key.rotate.result');
    expect(res.payload).toEqual({ requestId: env.id, ok: true });
    expect(await publicKeyOf(e.deviceId)).toBe(fresh.pubB64);

    const audit = await auditActions('device.key_rotated', e.deviceId);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toContain(fresh.pubB64); // to'liq kalit emas, faqat fingerprint
    expect(audit[0]!.details['previous_fingerprint']).toMatch(/^[0-9a-f]{16}$/);
    expect(audit[0]!.details['new_fingerprint']).not.toBe(audit[0]!.details['previous_fingerprint']);

    // Ochiq ulanish ishlashda davom etadi; eski kalit yangi ulanishda RAD etiladi, yangisi ishlaydi.
    const old = openSocket(AGENT_WS_PATH);
    await old.opened;
    const ch = await old.nextOf('auth.challenge');
    const ts = Date.now();
    old.send(createEnvelope('auth.response', { deviceId: e.deviceId, ts, signature: sign(null, Buffer.from(buildAgentAuthString({ nonce: ch.payload.nonce as string, ts, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url'), agentdVersion: '0.1.0-test', hostname: 'zz-host', os: 'linux' }));
    expect((await old.nextOf('auth.error')).payload['code']).toBe('unauthorized');
    expect(await old.closed).toBe(AGENT_WS_CLOSE.authFailed);

    const next = await connectAgent({ ...e, keys: fresh });
    expect(next.authOk.type).toBe('auth.ok');
    // Verifier ham eski kalitni darhol rad etadi (kesh kalitga bog'liq).
    await expect(
      svc(DeviceSignatureVerifier).verifyAgentChallenge({
        deviceId: e.deviceId, ts: Date.now(), nonce: randomBytes(32).toString('base64url'),
        signature: sign(null, Buffer.from(buildAgentAuthString({ nonce: 'x', ts: 1, deviceId: e.deviceId }), 'utf8'), e.keys.priv).toString('base64url'),
      }),
    ).rejects.toBeInstanceOf(SignatureError);
  });

  it('rejects bad signatures, stale timestamps, the same key, a key already used by another device, and replays', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const rotate = async (env: ReturnType<typeof createEnvelope>) => {
      a.send(env);
      return (await a.nextOf('key.rotate.result')).payload;
    };
    expect(await rotate(rotationEnvelope(e, newKeys(), { badNew: true }))).toMatchObject({ ok: false, code: 'invalid_signature' });
    expect(await rotate(rotationEnvelope(e, newKeys(), { badOld: true }))).toMatchObject({ ok: false, code: 'invalid_signature' });
    expect(await rotate(rotationEnvelope(e, newKeys(), { ts: Date.now() - 5 * 60_000 }))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(await rotate(rotationEnvelope(e, e.keys))).toMatchObject({ ok: false, code: 'same_key' });
    expect(await publicKeyOf(e.deviceId)).toBe(e.keys.pubB64); // hech narsa o'zgarmadi

    const other = await enroll('zz-5.1-other');
    expect(await rotate(rotationEnvelope(e, other.keys))).toMatchObject({ ok: false, code: 'key_in_use' });

    // Takror (replay): muvaffaqiyatli almashtirishdan keyin AYNI yuk yaroqsiz (eski kalit endi joriy emas).
    const fresh = newKeys();
    const good = rotationEnvelope(e, fresh);
    expect(await rotate(good)).toMatchObject({ ok: true });
    a.send({ ...good, id: createEnvelope('x', {}).id });
    const replay = (await a.nextOf('key.rotate.result')).payload;
    expect(replay['ok']).toBe(false);
    expect(['same_key', 'invalid_signature']).toContain(replay['code']);
    expect(await publicKeyOf(e.deviceId)).toBe(fresh.pubB64);
    expect(await auditActions('device.key_rotated', e.deviceId)).toHaveLength(1);
  });

  it('a revoked device cannot rotate; rotation attempts are rate limited', async () => {
    const e = await enroll();
    const keysSvc = svc(DeviceKeysService);
    const payload = (n: Keys) => {
      const ts = Date.now();
      const c = Buffer.from(buildKeyRotationString({ deviceId: e.deviceId, oldPublicKey: e.keys.pubB64, newPublicKey: n.pubB64, ts }), 'utf8');
      return { newPublicKey: n.pubB64, ts, oldSignature: sign(null, c, e.keys.priv).toString('base64url'), newSignature: sign(null, c, n.priv).toString('base64url') };
    };
    for (let i = 0; i < 10; i++) await keysSvc.rotate(e.deviceId, { ...payload(newKeys()), oldSignature: 'A'.repeat(86) }, 'test'); // yaroqsiz imzo ham urinish hisobiga kiradi
    expect(await keysSvc.rotate(e.deviceId, payload(newKeys()), 'test')).toEqual({ ok: false, code: 'rate_limited' });

    const r = await enroll();
    await svc(DevicesService).revoke(r.deviceId, 'agentd', 'test');
    const ts = Date.now();
    const n = newKeys();
    const c = Buffer.from(buildKeyRotationString({ deviceId: r.deviceId, oldPublicKey: r.keys.pubB64, newPublicKey: n.pubB64, ts }), 'utf8');
    expect(await keysSvc.rotate(r.deviceId, { newPublicKey: n.pubB64, ts, oldSignature: sign(null, c, r.keys.priv).toString('base64url'), newSignature: sign(null, c, n.priv).toString('base64url') }, 'test')).toEqual({ ok: false, code: 'revoked' });
  });

  it('center-initiated rotation: connected agent is asked immediately; a reconnecting one gets auth.ok.rotationRequired; the flag clears after rotation', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    expect(a.authOk.payload['rotationRequired']).toBeUndefined();
    await svc(DeviceKeysService).requireRotation(e.deviceId, 'test');
    await a.nextOf('key.rotation_required', 2000);
    expect((await auditActions('device.rotation_required', e.deviceId)).length).toBe(1);

    const again = await connectAgent(e); // yangi ulanish eskisini almashtiradi (4009)
    expect(again.authOk.payload['rotationRequired']).toBe(true);
    const fresh = newKeys();
    again.send(rotationEnvelope(e, fresh));
    expect((await again.nextOf('key.rotate.result')).payload).toMatchObject({ ok: true });
    const rows: Array<{ rotation_required: boolean; key_rotated_at: Date | null }> = await ds.query(`SELECT rotation_required, key_rotated_at FROM devices WHERE id = $1`, [e.deviceId]);
    expect(rows[0]!.rotation_required).toBe(false);
    expect(rows[0]!.key_rotated_at).not.toBeNull();
    await expect(svc(DeviceKeysService).requireRotation('00000000-0000-0000-0000-000000000000', 'test')).rejects.toThrow(/not found/);
  });
});

describe('revoke = immediate disconnect (sweeps are 10 minutes: only LISTEN/NOTIFY can close these)', () => {
  it('device revoke closes /ws/agent with 4010 at once', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    const t0 = Date.now();
    await svc(DevicesService).revoke(e.deviceId, 'agentd', 'cli');
    expect(await a.closed).toBe(AGENT_WS_CLOSE.revoked);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a raw SQL revoke from another process (CLI / Telegram chat removal path) is caught by the DB trigger', async () => {
    const e = await enroll();
    const a = await connectAgent(e);
    await ds.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [e.deviceId]);
    expect(await a.closed).toBe(AGENT_WS_CLOSE.revoked);
  });

  it('token revoke closes /ws/client with 4010 at once; self-revoke (pairing device) too; a rolled-back revoke does not', async () => {
    const t1 = await svc(ClientTokensService).issue({ kind: 'web', name: 'zz-revoke-1', scopes: ['read'] }, 'test');
    const c1 = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(t1.token));
    await c1.opened;
    await c1.nextOf('auth.ok');
    await svc(DevicesService).revoke(t1.id, 'client', 'cli');
    expect(await c1.closed).toBe(CLIENT_WS_CLOSE.revoked);

    const t2 = await svc(ClientTokensService).issue({ kind: 'mobile', name: 'zz-revoke-2', scopes: ['read'] }, 'test');
    const c2 = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(t2.token));
    await c2.opened;
    await c2.nextOf('auth.ok');
    await http().post('/v1/devices/me/revoke').set('Authorization', `Bearer ${t2.token}`).expect(200);
    expect(await c2.closed).toBe(CLIENT_WS_CLOSE.revoked);

    // Qaytarilgan tranzaksiya NOTIFY yubormaydi: ulanish tirik qoladi.
    const t3 = await svc(ClientTokensService).issue({ kind: 'web', name: 'zz-revoke-3', scopes: ['read'] }, 'test');
    const c3 = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(t3.token));
    await c3.opened;
    await c3.nextOf('auth.ok');
    await expect(
      ds.transaction(async (m) => {
        await m.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [t3.id]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await sleep(400);
    expect(c3.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('client token rotation (token rotate)', () => {
  it('issues a new token, keeps the old one valid for the grace period only, audits it', async () => {
    const old = await svc(ClientTokensService).issue({ kind: 'menubar', name: 'zz-rot-1', scopes: ['read', 'approve'], expiresInDays: 90 }, 'test');
    // Grace ~2 soniya (0.00056 soat).
    const rotated = await svc(ClientTokensService).rotate(old.id, { graceHours: 0.00056 }, 'test');
    expect(rotated.rotated_from).toBe(old.id);
    expect(rotated.token).not.toBe(old.token);
    expect(rotated.scopes).toEqual(['read', 'approve']);
    expect(rotated.kind).toBe('menubar');
    expect(rotated.grace_ends_at).not.toBeNull();

    await http().get('/v1/devices/me').set('Authorization', `Bearer ${old.token}`).expect(200); // grace ichida
    await http().get('/v1/devices/me').set('Authorization', `Bearer ${rotated.token}`).expect(200);
    await sleep(2300);
    await http().get('/v1/devices/me').set('Authorization', `Bearer ${old.token}`).expect(401); // grace tugadi
    await http().get('/v1/devices/me').set('Authorization', `Bearer ${rotated.token}`).expect(200);

    const audit = await auditActions('token.rotated', rotated.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details['rotated_from']).toBe(old.id);
    expect(JSON.stringify(audit[0]!.details)).not.toContain(rotated.token);
  });

  it('grace 0 revokes the old token immediately and closes its /ws/client with 4010', async () => {
    const old = await svc(ClientTokensService).issue({ kind: 'web', name: 'zz-rot-2', scopes: ['read'] }, 'test');
    const c = openSocket(CLIENT_WS_PATH, buildClientSubprotocols(old.token));
    await c.opened;
    await c.nextOf('auth.ok');
    const rotated = await svc(ClientTokensService).rotate(old.id, { graceHours: 0 }, 'test');
    expect(rotated.grace_ends_at).toBeNull();
    expect(await c.closed).toBe(CLIENT_WS_CLOSE.revoked);
    await http().get('/v1/devices/me').set('Authorization', `Bearer ${old.token}`).expect(401);
    await http().get('/v1/devices/me').set('Authorization', `Bearer ${rotated.token}`).expect(200);
  });

  it('refuses agentd/telegram/revoked/unknown ids; step-up exemption is only inherited on request', async () => {
    const tokens = svc(ClientTokensService);
    const e = await enroll();
    await expect(tokens.rotate(e.deviceId, { graceHours: 1 }, 'test')).rejects.toThrow(/no rotatable client token/);
    await expect(tokens.rotate('00000000-0000-0000-0000-000000000000', { graceHours: 1 }, 'test')).rejects.toThrow(/not found/);
    await expect(tokens.rotate(e.deviceId, { graceHours: -1 }, 'test')).rejects.toThrow(/grace-hours/);
    const gone = await tokens.issue({ kind: 'web', name: 'zz-rot-3', scopes: ['read'] }, 'test');
    await svc(DevicesService).revoke(gone.id, 'client', 'test');
    await expect(tokens.rotate(gone.id, { graceHours: 1 }, 'test')).rejects.toThrow(/already revoked/);

    const dash = await tokens.issue({ kind: 'web', name: 'zz-rot-dash', scopes: ['read', 'control'] }, 'test');
    await ds.query(`INSERT INTO settings (key, value) VALUES ('commands.stepup_exempt_device_ids', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify([dash.id])]);
    const plain = await tokens.rotate(dash.id, { graceHours: 1 }, 'test');
    expect(plain.stepup_exempt_inherited).toBe(false);
    const dash2 = await tokens.issue({ kind: 'web', name: 'zz-rot-dash2', scopes: ['read'] }, 'test');
    await ds.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'commands.stepup_exempt_device_ids'`, [JSON.stringify([dash2.id])]);
    const inherited = await tokens.rotate(dash2.id, { graceHours: 1, inheritStepUpExempt: true }, 'test');
    expect(inherited.stepup_exempt_inherited).toBe(true);
    const ids: Array<{ value: string[] }> = await ds.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    expect(ids[0]!.value).toEqual([dash2.id, inherited.id]);
  });
});

describe('center signing key rotation with overlap window', () => {
  it('rotate: new key signs, old key signs the announcement, agents with the OLD pin get it on auth.ok, others do not; audited; server reloads via NOTIFY', async () => {
    const signer = svc(CommandSignerService);
    const admin = svc(CenterKeyAdminService);
    const before = { pub: signer.publicKey, fp: signer.fingerprint };

    const agent = await enroll('zz-5.1-center-key');
    const r = await admin.rotate(7, 'test');
    expect(r.previousFingerprint).toBe(before.fp);
    expect(signer.fingerprint).toBe(r.newFingerprint);
    expect(signer.publicKey).not.toBe(before.pub);
    const st = admin.status();
    expect(st.overlap).toHaveLength(1);
    expect(st.overlap[0]!.fromFingerprint).toBe(before.fp);

    // Eski pin'li agent: auth.ok yangi kalit + imzolangan e'lon (eski kalit bilan tekshiriladi).
    const old = await connectAgent(agent, { centerKeyFingerprint: before.fp });
    expect(old.authOk.payload['centerPublicKey']).toBe(signer.publicKey);
    const rotations = old.authOk.payload['centerKeyRotations'] as Array<{ previousPublicKey: string; newPublicKey: string; issuedAt: number; expiresAt: number; signature: string }>;
    expect(rotations).toHaveLength(1);
    const rot = rotations[0]!;
    expect(rot.previousPublicKey).toBe(before.pub);
    expect(rot.newPublicKey).toBe(signer.publicKey);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(rot.previousPublicKey, 'base64url')]);
    const { createPublicKey } = await import('node:crypto');
    expect(verify(null, Buffer.from(buildCenterKeyRotationString(rot), 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(rot.signature, 'base64url'))).toBe(true);
    expect(rot.expiresAt - rot.issuedAt).toBe(7 * 86_400_000);

    // Yangi pin'li (yoki pin'siz) agentga e'lon yuborilmaydi.
    const current = await connectAgent(agent, { centerKeyFingerprint: signer.fingerprint });
    expect(current.authOk.payload['centerKeyRotations']).toBeUndefined();
    const none = await connectAgent(agent);
    expect(none.authOk.payload['centerKeyRotations']).toBeUndefined();

    expect((await auditActions('center_key.rotated')).length).toBe(1);
    const announced = await auditActions('center_key.rotation_announced', agent.deviceId);
    expect(announced).toHaveLength(1);
    expect(announced[0]!.details).toMatchObject({ from_fingerprint: before.fp, steps: 1 });
  });

  it('a rotation done by ANOTHER process (CLI) is picked up by the running server through NOTIFY', async () => {
    const signer = svc(CommandSignerService);
    const file = signer.keyFilePath!;
    const fpBefore = signer.fingerprint;
    const r = rotateSignerKeyFile(file, Date.now(), 3); // CLI jarayoni: faqat fayl
    expect(signer.fingerprint).toBe(fpBefore); // server hali eski kalitda
    await notifyDeviceEvent(ds, 'center_key_rotated');
    const end = Date.now() + 3000;
    while (signer.fingerprint === fpBefore && Date.now() < end) await sleep(25);
    expect(signer.fingerprint).toBe(r.newFingerprint);
  });

  it('after the overlap window expires nothing is announced (manual reset required)', async () => {
    const signer = svc(CommandSignerService);
    const old = signer.fingerprint;
    rotateSignerKeyFile(signer.keyFilePath!, Date.now() - 10 * 86_400_000, 1); // 9 kun oldin tugagan oyna
    signer.reload();
    expect(signer.rotationsFor(old)).toEqual([]);
  });
});
