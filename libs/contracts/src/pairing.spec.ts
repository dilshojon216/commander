import { describe, expect, it } from 'vitest';
import {
  ClientDeviceMeResponseSchema,
  ClientPairBodySchema,
  ClientPairResponseSchema,
  ClientRevokeResponseSchema,
  PAIRING_SCOPES,
  buildPairingUrl,
  parsePairingUrl,
} from './identity.js';

const UUID = '3f2b8c1e-5a4d-4e6f-9b1a-2c3d4e5f6a7b';

describe('pairing URL', () => {
  it('build -> parse round-trip (center url, code, fingerprint)', () => {
    const url = buildPairingUrl({ centerUrl: 'https://mac.tail1234.ts.net', code: 'ABCDE-FGHJK', fingerprint: 'sha256:ab12' });
    expect(url.startsWith('commander://pair?')).toBe(true);
    expect(parsePairingUrl(url)).toEqual({ centerUrl: 'https://mac.tail1234.ts.net', code: 'ABCDE-FGHJK', fingerprint: 'sha256:ab12' });
  });

  it('fp is optional', () => {
    const url = buildPairingUrl({ centerUrl: 'https://c.example', code: 'ABCDE-FGHJK' });
    expect(url).not.toContain('fp=');
    expect(parsePairingUrl(url)?.fingerprint).toBeNull();
  });

  it('rejects wrong scheme/host, missing params, plain http (except loopback), garbage', () => {
    expect(parsePairingUrl('https://pair?c=https%3A%2F%2Fx.y&code=A')).toBeNull();
    expect(parsePairingUrl('commander://other?c=https%3A%2F%2Fx.y&code=A')).toBeNull();
    expect(parsePairingUrl('commander://pair?code=A')).toBeNull();
    expect(parsePairingUrl('commander://pair?c=https%3A%2F%2Fx.y')).toBeNull();
    expect(parsePairingUrl('commander://pair?c=http%3A%2F%2Fevil.example&code=A')).toBeNull();
    expect(parsePairingUrl('commander://pair?c=not-a-url&code=A')).toBeNull();
    expect(parsePairingUrl('not a url')).toBeNull();
    expect(parsePairingUrl('commander://pair?c=http%3A%2F%2F127.0.0.1%3A4317&code=A')?.centerUrl).toBe('http://127.0.0.1:4317');
  });
});

describe('pairing schemas', () => {
  it('body: strict, platform/deviceName required, publicKey optional raw ed25519', () => {
    const ok = { code: 'ABCDE-FGHJK', deviceName: "Alex's iPhone", platform: 'ios' };
    expect(ClientPairBodySchema.safeParse(ok).success).toBe(true);
    expect(ClientPairBodySchema.safeParse({ ...ok, publicKey: 'A'.repeat(43) }).success).toBe(true);
    expect(ClientPairBodySchema.safeParse({ ...ok, publicKey: 'short' }).success).toBe(false);
    expect(ClientPairBodySchema.safeParse({ ...ok, scopes: ['admin'] }).success).toBe(false);
    expect(ClientPairBodySchema.safeParse({ ...ok, deviceName: '  ' }).success).toBe(false);
    expect(ClientPairBodySchema.safeParse({ code: 'x' }).success).toBe(false);
  });

  it('response, me and revoke shapes', () => {
    expect(ClientPairResponseSchema.safeParse({ token: 'cmdr_x', deviceId: UUID, kind: 'mobile', name: 'n', scopes: ['read'], expiresAt: null, serverTime: 't' }).success).toBe(true);
    expect(
      ClientDeviceMeResponseSchema.safeParse({ deviceId: UUID, kind: 'menubar', name: null, platform: 'macos', scopes: ['read', 'approve'], createdAt: 't', lastUsedAt: null, expiresAt: null, stepUpExempt: false, serverTime: 't' }).success,
    ).toBe(true);
    expect(ClientRevokeResponseSchema.safeParse({ revoked: true, deviceId: UUID }).success).toBe(true);
    expect(ClientRevokeResponseSchema.safeParse({ revoked: false, deviceId: UUID }).success).toBe(false);
  });

  it('admin is never a pairing scope', () => {
    expect(PAIRING_SCOPES).toEqual(['read', 'approve', 'control']);
  });
});
