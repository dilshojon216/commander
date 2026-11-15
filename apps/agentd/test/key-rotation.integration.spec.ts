import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyRotatePayloadSchema, buildKeyRotationString } from '@commander/contracts';
import type { CenterKeyRotation } from '@commander/contracts';
import { fingerprintOf } from '../src/center-pin.js';
import { discardNextKey, generateDeviceKey, loadNextKey, loadPrivateKey, nextKeyFile, promoteNextKey, publicKeyRawOf, storeNextKey, storePrivateKey } from '../src/identity.js';
import { KeyRotator } from '../src/key-rotation.js';
import { silentLogger } from '../src/logger.js';
import { resolvePaths } from '../src/paths.js';
import { AgentWsClient } from '../src/ws-client.js';
import { FakeCenter } from './fake-center.js';
import { makeStores, waitFor } from './helpers.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(extra: Partial<ConstructorParameters<typeof AgentWsClient>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cmdr-agentd-rotint-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolvePaths(home, process.platform, { COMMANDER_HOME: home });
  const key = generateDeviceKey();
  storePrivateKey(paths, key.privateKey);
  const center = new FakeCenter(key.publicKeyRaw);
  const port = await center.start();
  const stores = makeStores();
  let current = key.privateKey;
  const client = new AgentWsClient({
    url: `ws://127.0.0.1:${port}/ws/agent`,
    deviceId: DEVICE,
    privateKey: key.privateKey,
    outbox: stores.outbox,
    log: silentLogger,
    agentdVersion: '0.0.0-test',
    hostname: 'test-host',
    os: 'darwin',
    backoff: { baseMs: 20, maxMs: 80 },
    stableAfterMs: 50,
    ...extra,
  });
  cleanups.push(() => client.stop(), () => center.stop().catch(() => undefined));
  return { paths, key, center, client, getKey: () => current, setKey: (k: typeof current) => { current = k; } };
}

/** Markazning `key.rotate` ishlovchisi: ikkala imzoni tekshiradi, kalitni almashtiradi (haqiqiy markaz mantig'i soddalashtirilgan). */
function installRotateHandler(center: FakeCenter, deviceId: string): { applied: () => number } {
  let n = 0;
  center.handler = (msg, ws, c) => {
    if (msg.type !== 'key.rotate') return 'default';
    const p = KeyRotatePayloadSchema.parse(msg.payload);
    const canonical = Buffer.from(buildKeyRotationString({ deviceId, oldPublicKey: c.publicKeyRaw, newPublicKey: p.newPublicKey, ts: p.ts }), 'utf8');
    const k = (raw: string) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    const ok = verify(null, canonical, k(c.publicKeyRaw), Buffer.from(p.oldSignature, 'base64url')) && verify(null, canonical, k(p.newPublicKey), Buffer.from(p.newSignature, 'base64url'));
    if (ok) {
      c.publicKeyRaw = p.newPublicKey;
      n++;
    }
    c.send(ws, 'key.rotate.result', { requestId: msg.id, ok, ...(ok ? {} : { code: 'invalid_signature' }) });
    return 'skip';
  };
  return { applied: () => n };
}

describe('key rotation end-to-end (AgentWsClient <-> fake center)', () => {
  it('rotates over the authenticated WS; the next connection authenticates with the NEW key', async () => {
    const t = await setup();
    const handler = installRotateHandler(t.center, DEVICE);
    const rotator = new KeyRotator({
      paths: t.paths, deviceId: DEVICE, log: silentLogger, getKey: t.getKey,
      setKey: (k) => { t.setKey(k); t.client.setSigningKey(k); },
      isReady: () => t.client.isReady(), rotateKey: (p) => t.client.rotateKey(p),
    });
    t.client.start();
    await waitFor(() => t.client.getState() === 'ready');
    const oldPub = t.key.publicKeyRaw;

    const res = await rotator.rotate();
    expect(res.ok).toBe(true);
    expect(handler.applied()).toBe(1);
    expect(t.center.publicKeyRaw).not.toBe(oldPub);
    expect(publicKeyRawOf(loadPrivateKey(t.paths))).toBe(t.center.publicKeyRaw);
    expect(existsSync(nextKeyFile(t.paths))).toBe(false);

    // Ulanishni uzamiz: yangi ulanish YANGI kalit bilan o'tadi (markaz eski kalitni endi qabul qilmaydi).
    const before = t.center.authResults.length;
    for (const ws of t.center.wss.clients) ws.close(1001, 'restart');
    await waitFor(() => t.center.authResults.length > before && t.client.getState() === 'ready');
    expect(t.center.authResults.at(-1)!.ok).toBe(true);
  });

  it('a center rejection leaves the old key working', async () => {
    const t = await setup();
    t.center.handler = (msg, ws, c) => {
      if (msg.type !== 'key.rotate') return 'default';
      c.send(ws, 'key.rotate.result', { requestId: msg.id, ok: false, code: 'rate_limited' });
      return 'skip';
    };
    const rotator = new KeyRotator({ paths: t.paths, deviceId: DEVICE, log: silentLogger, getKey: t.getKey, setKey: (k) => t.client.setSigningKey(k), isReady: () => t.client.isReady(), rotateKey: (p) => t.client.rotateKey(p) });
    t.client.start();
    await waitFor(() => t.client.getState() === 'ready');
    expect((await rotator.rotate()).ok).toBe(false);
    expect(publicKeyRawOf(loadPrivateKey(t.paths))).toBe(t.key.publicKeyRaw);
    expect(existsSync(nextKeyFile(t.paths))).toBe(false);
  });

  it('a lost result (center applied it, agent did not hear back) is recovered on reconnect via the fallback key', async () => {
    const accepted: string[] = [];
    let promoted = 0;
    const t = await setup({
      fallbackKey: () => loadNextKey(t0.paths),
      onFallbackKeyAccepted: (k) => {
        promoted++;
        promoteNextKey(t0.paths);
        t0.setKey(k);
        accepted.push(publicKeyRawOf(k));
      },
      onPrimaryKeyConfirmed: () => discardNextKey(t0.paths),
    });
    const t0 = t;
    // Markaz kalitni almashtirgan, lekin agent faqat zaxira faylni biladi (natija yetib kelmagan).
    const next = generateDeviceKey();
    storeNextKey(t.paths, next.privateKey);
    t.center.publicKeyRaw = next.publicKeyRaw;
    t.client.start();
    await waitFor(() => t.client.getState() === 'ready', 8000);
    expect(t.center.authResults.map((a) => a.ok)).toEqual([false, true]); // asosiy rad etildi, zaxira o'tdi
    expect(promoted).toBe(1);
    expect(accepted).toEqual([next.publicKeyRaw]);
    expect(publicKeyRawOf(loadPrivateKey(t.paths))).toBe(next.publicKeyRaw);
    expect(existsSync(nextKeyFile(t.paths))).toBe(false);
  });

  it('a stale fallback file is deleted once the primary key authenticates', async () => {
    let confirmed = 0;
    const t = await setup({ onPrimaryKeyConfirmed: () => { confirmed++; discardNextKey(t1.paths); } });
    const t1 = t;
    storeNextKey(t.paths, generateDeviceKey().privateKey); // markaz hech qachon qabul qilmagan
    t.client.start();
    await waitFor(() => t.client.getState() === 'ready');
    expect(confirmed).toBe(1);
    expect(existsSync(nextKeyFile(t.paths))).toBe(false);
  });
});

describe('center-initiated rotation and center key announcements', () => {
  it('auth.ok.rotationRequired and key.rotation_required both trigger onRotationRequired', async () => {
    let calls = 0;
    const t = await setup({ onRotationRequired: () => void calls++ });
    t.center.authOkExtra = { rotationRequired: true };
    t.client.start();
    await waitFor(() => calls === 1);
    for (const ws of t.center.wss.clients) t.center.send(ws, 'key.rotation_required', {});
    await waitFor(() => calls === 2);
  });

  it('sends the pinned center key fingerprint in auth.response and passes announcements to the pin logic BEFORE onCenterKey', async () => {
    const order: string[] = [];
    const got: CenterKeyRotation[][] = [];
    const t = await setup({
      centerKeyFingerprint: () => fingerprintOf('A'.repeat(43)),
      onCenterKeyRotations: (r) => { order.push('rotations'); got.push(r); },
      onCenterKey: () => { order.push('key'); },
    });
    const rot: CenterKeyRotation = { previousPublicKey: 'A'.repeat(43), newPublicKey: 'B'.repeat(43), issuedAt: 1, expiresAt: 2, signature: 'S'.repeat(86) };
    t.center.authOkExtra = { centerPublicKey: 'B'.repeat(43), centerKeyRotations: [rot] };
    t.client.start();
    await waitFor(() => order.length === 2);
    expect(order).toEqual(['rotations', 'key']);
    expect(got[0]).toEqual([rot]);
    expect(t.center.authPayloads[0]!['centerKeyFingerprint']).toBe(fingerprintOf('A'.repeat(43)));
  });
});
