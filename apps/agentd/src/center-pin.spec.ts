import { describe, expect, it } from 'vitest';
import { decidePin, fingerprintOf } from './center-pin.js';

const K1 = 'A'.repeat(43);
const K2 = 'B'.repeat(43);
const pin = (k: string) => ({ publicKey: k, fingerprint: fingerprintOf(k), pinnedAt: 'x', via: 'enroll' as const });

describe('decidePin', () => {
  it('pin yo\'q + markaz kalit e\'lon qildi = TOFU pin', () => expect(decidePin(undefined, K1)).toEqual({ kind: 'pin', publicKey: K1 }));
  it('pin bor + bir xil = match', () => expect(decidePin(pin(K1), K1)).toEqual({ kind: 'match' }));
  it('pin bor + boshqa kalit = mismatch (pin O\'ZGARMAYDI)', () => expect(decidePin(pin(K1), K2)).toEqual({ kind: 'mismatch' }));
  it('markaz kalit e\'lon qilmadi (eski center) = none', () => {
    expect(decidePin(undefined, undefined)).toEqual({ kind: 'none' });
    expect(decidePin(pin(K1), undefined)).toEqual({ kind: 'none' });
  });
  it('fingerprint 16 hex va kalitga bog\'liq', () => {
    expect(fingerprintOf(K1)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf(K1)).not.toBe(fingerprintOf(K2));
  });
});

import { generateKeyPairSync, sign } from 'node:crypto';
import { buildCenterKeyRotationString } from '@commander/contracts';
import type { CenterKeyRotation } from '@commander/contracts';
import { applyCenterKeyRotations, verifyRotationSignature } from './center-pin.js';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: publicKey.export({ format: 'jwk' }).x as string };
}
function rotation(from: ReturnType<typeof keyPair>, toRaw: string, over: Partial<CenterKeyRotation> = {}): CenterKeyRotation {
  const parts = { previousPublicKey: from.raw, newPublicKey: toRaw, issuedAt: 1_000, expiresAt: 10_000_000 };
  return { ...parts, signature: sign(null, Buffer.from(buildCenterKeyRotationString(parts), 'utf8'), from.privateKey).toString('base64url'), ...over };
}
const pinOf = (raw: string) => ({ publicKey: raw, fingerprint: fingerprintOf(raw), pinnedAt: 'x', via: 'enroll' as const });

describe('applyCenterKeyRotations (5.1: markaz kaliti aylantirildi, pin TOFUsiz yangilanadi)', () => {
  it('moves the pin along a valid chain signed by each previous key', () => {
    const a = keyPair();
    const b = keyPair();
    const c = keyPair();
    const r = applyCenterKeyRotations(pinOf(a.raw), [rotation(a, b.raw), rotation(b, c.raw)], 5_000);
    expect(r.rejected).toBeNull();
    expect(r.applied).toBe(2);
    expect(r.pinned).toMatchObject({ publicKey: c.raw, via: 'rotation', fingerprint: fingerprintOf(c.raw) });
  });

  it('rejects a forged announcement (signed by an attacker key) and keeps the pin', () => {
    const a = keyPair();
    const attacker = keyPair();
    const evil = keyPair();
    const forged = rotation(attacker, evil.raw, { previousPublicKey: a.raw }); // imzo attacker kaliti bilan
    const r = applyCenterKeyRotations(pinOf(a.raw), [forged], 5_000);
    expect(r.applied).toBe(0);
    expect(r.rejected).toMatch(/imzo/);
    expect(r.pinned?.publicKey).toBe(a.raw);
    expect(verifyRotationSignature(forged)).toBe(false);
  });

  it('rejects an announcement that is not anchored on the current pin', () => {
    const a = keyPair();
    const b = keyPair();
    const c = keyPair();
    const r = applyCenterKeyRotations(pinOf(a.raw), [rotation(b, c.raw)], 5_000);
    expect(r).toMatchObject({ applied: 0, pinned: { publicKey: a.raw } });
    expect(r.rejected).toMatch(/bog'lanmagan/);
  });

  it('rejects an expired announcement (manual reset needed) and an unpinned agent (no TOFU shortcut)', () => {
    const a = keyPair();
    const b = keyPair();
    expect(applyCenterKeyRotations(pinOf(a.raw), [rotation(a, b.raw)], 10_000_001).rejected).toMatch(/muddati/);
    expect(applyCenterKeyRotations(undefined, [rotation(a, b.raw)], 5_000)).toMatchObject({ applied: 0, pinned: undefined });
  });

  it('stops at the first invalid step: earlier valid steps stay applied, the rest are not', () => {
    const a = keyPair();
    const b = keyPair();
    const c = keyPair();
    const bad = rotation(b, c.raw, { signature: 'A'.repeat(86) });
    const r = applyCenterKeyRotations(pinOf(a.raw), [rotation(a, b.raw), bad], 5_000);
    expect(r.applied).toBe(1);
    expect(r.pinned?.publicKey).toBe(b.raw);
    expect(r.rejected).toBeTruthy();
  });
});
