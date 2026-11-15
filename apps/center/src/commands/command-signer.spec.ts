import { createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCommandSigString, canonicalJson } from '@commander/contracts';
import { describe, expect, it } from 'vitest';
import { hashCommandPayload, loadOrCreateSignerKeys, newDispatchNonce, signCommand } from './command-signer.js';

describe('markaz buyruq imzosi', () => {
  it('imzo public key bilan tekshiriladi; payload yoki maydon o\'zgarsa buzilади', () => {
    const k = loadOrCreateSignerKeys(null);
    expect(k.publicKeyRaw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const payload = { claudeSessionId: 'abc', text: 'hi' };
    const parts = { deviceId: 'D'.repeat(8), commandId: 'c1', type: 'session.prompt' as const, nonce: newDispatchNonce(), expiresAt: 123, payloadSha256: hashCommandPayload(payload) };
    const sig = signCommand(k.privateKey, parts);
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.publicKeyRaw }, format: 'jwk' });
    const check = (p: typeof parts): boolean => verify(null, Buffer.from(buildCommandSigString(p), 'utf8'), pub, Buffer.from(sig, 'base64url'));
    expect(check(parts)).toBe(true);
    expect(check({ ...parts, payloadSha256: hashCommandPayload({ ...payload, text: 'rm' }) })).toBe(false);
    expect(check({ ...parts, expiresAt: 124 })).toBe(false);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
  it('canonicalJson kalit tartibiga bog\'liq emas; nonce 43 belgi va takrorlanmaydi', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } })).toBe(canonicalJson({ a: { c: undefined, d: [1, { x: 2, y: 1 }] }, b: 1 }));
    expect(newDispatchNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDispatchNonce()).not.toBe(newDispatchNonce());
  });
  it.skipIf(process.platform === 'win32')('kalit fayli: yaratiladi (0600), qayta yuklanganda bir xil; ochiq ruxsatli fayl rad etiladi', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmdr-key-'));
    try {
      const file = path.join(dir, 'sub', 'k.pem');
      const a = loadOrCreateSignerKeys(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(loadOrCreateSignerKeys(file).publicKeyRaw).toBe(a.publicKeyRaw);
      chmodSync(file, 0o644);
      expect(() => loadOrCreateSignerKeys(file)).toThrow(/chmod 600/);
      const junk = path.join(dir, 'junk.pem');
      writeFileSync(junk, 'not a key', { mode: 0o600 });
      expect(() => loadOrCreateSignerKeys(junk)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
