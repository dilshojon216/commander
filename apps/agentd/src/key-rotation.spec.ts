import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildKeyRotationString } from '@commander/contracts';
import type { KeyRotatePayload, KeyRotateResultPayload } from '@commander/contracts';
import { generateDeviceKey, loadNextKey, loadPrivateKey, nextKeyFile, publicKeyRawOf, storePrivateKey } from './identity.js';
import { KeyRotator } from './key-rotation.js';
import { silentLogger } from './logger.js';
import { resolvePaths } from './paths.js';

const DEVICE = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cmdr-agentd-rot-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function setup(rotateKey: (p: KeyRotatePayload) => Promise<KeyRotateResultPayload>, ready = true) {
  const paths = resolvePaths(home, process.platform, { COMMANDER_HOME: home });
  const old = generateDeviceKey();
  storePrivateKey(paths, old.privateKey);
  let current: KeyObject = old.privateKey;
  const rotator = new KeyRotator({
    paths,
    deviceId: DEVICE,
    log: silentLogger,
    getKey: () => current,
    setKey: (k) => {
      current = k;
    },
    isReady: () => ready,
    rotateKey,
  });
  return { paths, old, rotator, key: () => current };
}

describe('KeyRotator', () => {
  it('signs the SAME canonical string with the old AND the new key, swaps the file atomically and the in-memory key', async () => {
    let seen: KeyRotatePayload | undefined;
    const { paths, old, rotator, key } = setup(async (p) => {
      seen = p;
      expect(existsSync(nextKeyFile(paths))).toBe(true); // markazga yuborishdan OLDIN zaxira yozilgan
      return { requestId: '00000000-0000-4000-8000-000000000000', ok: true };
    });
    const res = await rotator.rotate();
    expect(res.ok).toBe(true);

    const canonical = Buffer.from(buildKeyRotationString({ deviceId: DEVICE, oldPublicKey: old.publicKeyRaw, newPublicKey: seen!.newPublicKey, ts: seen!.ts }), 'utf8');
    const spki = (raw: string) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    expect(verify(null, canonical, spki(old.publicKeyRaw), Buffer.from(seen!.oldSignature, 'base64url'))).toBe(true);
    expect(verify(null, canonical, spki(seen!.newPublicKey), Buffer.from(seen!.newSignature, 'base64url'))).toBe(true);

    expect(publicKeyRawOf(key())).toBe(seen!.newPublicKey);
    expect(publicKeyRawOf(loadPrivateKey(paths))).toBe(seen!.newPublicKey); // fayl ham yangi
    expect(existsSync(nextKeyFile(paths))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(paths.keyFile).mode & 0o077).toBe(0);
  });

  it('an explicit rejection discards the new key and keeps the old one', async () => {
    const { paths, old, rotator, key } = setup(async () => ({ requestId: '00000000-0000-4000-8000-000000000000', ok: false, code: 'rate_limited' }));
    const res = await rotator.rotate();
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('rate_limited') });
    expect(existsSync(nextKeyFile(paths))).toBe(false);
    expect(publicKeyRawOf(key())).toBe(old.publicKeyRaw);
    expect(publicKeyRawOf(loadPrivateKey(paths))).toBe(old.publicKeyRaw);
  });

  it('an unknown outcome (timeout) KEEPS the new key as the fallback: the center may have applied it', async () => {
    const { paths, old, rotator, key } = setup(async () => {
      throw new Error('key.rotate.result kelmadi (timeout)');
    });
    const res = await rotator.rotate();
    expect(res.ok).toBe(false);
    expect(publicKeyRawOf(key())).toBe(old.publicKeyRaw); // asosiy kalit o'zgarmadi
    expect(loadNextKey(paths)).toBeDefined();
    expect(readFileSync(paths.keyFile)).toEqual(readFileSync(paths.keyFile)); // fayl butun
  });

  it('refuses when the center connection is not ready and writes nothing', async () => {
    const { paths, rotator } = setup(async () => ({ requestId: '00000000-0000-4000-8000-000000000000', ok: true }), false);
    expect((await rotator.rotate()).ok).toBe(false);
    expect(existsSync(nextKeyFile(paths))).toBe(false);
  });

  it('concurrent calls share one rotation', async () => {
    let calls = 0;
    const { rotator } = setup(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { requestId: '00000000-0000-4000-8000-000000000000', ok: true };
    });
    const [a, b] = await Promise.all([rotator.rotate(), rotator.rotate()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });
});
