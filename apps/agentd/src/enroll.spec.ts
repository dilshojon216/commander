import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentAuthString, EnrollRequestSchema } from '@commander/contracts';
import { tmpHome } from '../test/helpers.js';
import { loadConfig } from './config.js';
import { enroll, isEnrollTransportSafe } from './enroll.js';
import { loadPrivateKey, signAgentAuth } from './identity.js';
import { silentLogger } from './logger.js';
import { resolvePaths } from './paths.js';

const homes: Array<() => void> = [];
afterEach(() => homes.splice(0).forEach((c) => c()));

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const MACHINE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function fakeFetch(status: number, body: unknown, captured: { body?: unknown; url?: string }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('enroll', () => {
  it("kalit 0600, dir 0700, config yoziladi, public key xom JWK x, imzo center tekshiradigan satrga mos", async () => {
    const h = tmpHome();
    homes.push(h.cleanup);
    const paths = resolvePaths(h.dir + '/.commander');
    const cap: { body?: unknown; url?: string } = {};
    const res = await enroll(paths, { centerUrl: 'https://center.example/', code: 'ABCD-EFGH', fetchFn: fakeFetch(201, { device_id: DEVICE, machine_id: MACHINE }, cap) }, silentLogger);

    expect(res).toEqual({ deviceId: DEVICE, machineId: MACHINE });
    expect(cap.url).toBe('https://center.example/v1/enroll');
    const body = EnrollRequestSchema.parse(cap.body); // center sxemasiga mos
    expect(body.code).toBe('ABCD-EFGH');
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(paths.keyFile).mode & 0o777).toBe(0o600);
    expect(loadConfig(paths)).toMatchObject({ centerUrl: 'https://center.example', deviceId: DEVICE, machineId: MACHINE });

    // public key aynan saqlangan maxfiy kalitga tegishli: imzo tekshiriladi
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: body.public_key }, format: 'jwk' });
    const parts = { nonce: 'n'.repeat(43), ts: 1794542524823, deviceId: DEVICE };
    const sig = signAgentAuth(loadPrivateKey(paths), parts);
    expect(sig).toHaveLength(86);
    expect(verify(null, Buffer.from(buildAgentAuthString(parts)), pub, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it("xatoda (401) kalit va config qoldirilmaydi", async () => {
    const h = tmpHome();
    homes.push(h.cleanup);
    const paths = resolvePaths(h.dir + '/.commander');
    await expect(enroll(paths, { centerUrl: 'https://c.example', code: 'BAD', fetchFn: fakeFetch(401, { error: 'invalid_enrollment_code' }, {}) }, silentLogger)).rejects.toThrow(/401/);
    expect(existsSync(paths.keyFile)).toBe(false);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  it("allaqachon enroll qilingan mashinada --force'siz rad etadi va kalitni o'zgartirmaydi", async () => {
    const h = tmpHome();
    homes.push(h.cleanup);
    const paths = resolvePaths(h.dir + '/.commander');
    const ok = fakeFetch(201, { device_id: DEVICE, machine_id: MACHINE }, {});
    await enroll(paths, { centerUrl: 'https://c.example', code: 'AAAA-BBBB', fetchFn: ok }, silentLogger);
    const before = readFileSync(paths.keyFile, 'utf8');
    await expect(enroll(paths, { centerUrl: 'https://c.example', code: 'CCCC-DDDD', fetchFn: ok }, silentLogger)).rejects.toThrow(/allaqachon enroll/);
    expect(readFileSync(paths.keyFile, 'utf8')).toBe(before);
  });

  it('xato matnida kod yoki kalit chiqmaydi', async () => {
    const h = tmpHome();
    homes.push(h.cleanup);
    const paths = resolvePaths(h.dir + '/.commander');
    const err = await enroll(paths, { centerUrl: 'https://c.example', code: 'SECR-ETCD', fetchFn: fakeFetch(401, { error: 'x' }, {}) }, silentLogger).catch((e: Error) => e);
    expect(String(err)).not.toContain('SECR-ETCD');
  });
});

describe('enroll: transport xavfsizligi (L-23)', () => {
  it('https har doim; http faqat loopback/tailnet', () => {
    expect(isEnrollTransportSafe('https://center.ts.net')).toBe(true);
    expect(isEnrollTransportSafe('http://127.0.0.1:4317')).toBe(true);
    expect(isEnrollTransportSafe('http://localhost:4317')).toBe(true);
    expect(isEnrollTransportSafe('http://100.80.1.2:4317')).toBe(true);
    expect(isEnrollTransportSafe('http://192.168.1.5:4317')).toBe(false);
    expect(isEnrollTransportSafe('http://100.200.1.2')).toBe(false);
    expect(isEnrollTransportSafe('http://example.com')).toBe(false);
    expect(isEnrollTransportSafe('ftp://x')).toBe(false);
  });
});
