import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { generatePairingCode, hashEnrollmentCode, normalizeEnrollmentCode } from '../common/crypto.util.js';
import { FixedWindowLimiter } from '../common/rate-limiter.js';
import { PAIR_FAIL_GLOBAL_LIMIT, PAIR_FAIL_IP_LIMIT, PAIR_FAIL_WINDOW_MS } from '../common/security-events.service.js';
import { normalizePairingScopes } from './pairing.service.js';

describe('pairing code', () => {
  it('XXXXX-XXXXX Crockford, 50 bit, unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
  });

  it('normalization: case, dash, spaces, O/I/L ambiguity; hash is of the canonical form', () => {
    expect(normalizeEnrollmentCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeEnrollmentCode(' ab cde fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeEnrollmentCode('0O1IL-0O1IL')).toBe('0011100111');
    expect(hashEnrollmentCode('abcde-fghjk')).toBe(hashEnrollmentCode('ABCDE FGHJK'));
    expect(hashEnrollmentCode('abcde-fghjk')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizePairingScopes', () => {
  it('accepts read/approve/control, dedupes, trims', () => {
    expect(normalizePairingScopes(['read', ' approve', 'read'])).toEqual(['read', 'approve']);
    expect(normalizePairingScopes(['control'])).toEqual(['control']);
  });
  it('rejects admin, unknown and empty', () => {
    for (const bad of [['admin'], ['read', 'admin'], ['root'], [], ['']]) {
      expect(() => normalizePairingScopes(bad)).toThrow(BadRequestException);
    }
  });
});

describe('pairing failure limiters (same semantics as enrollment)', () => {
  it('per-IP 5 and global 10 failures block, window resets', () => {
    const ip = new FixedWindowLimiter(PAIR_FAIL_IP_LIMIT, PAIR_FAIL_WINDOW_MS);
    const glob = new FixedWindowLimiter(PAIR_FAIL_GLOBAL_LIMIT, PAIR_FAIL_WINDOW_MS);
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) ip.hit('p', t0);
    expect(ip.isBlocked('p', t0)).toBe(false);
    ip.hit('p', t0);
    expect(ip.isBlocked('p', t0)).toBe(true);
    for (let i = 0; i < 10; i++) glob.hit('global', t0);
    expect(glob.isBlocked('global', t0)).toBe(true);
    expect(ip.isBlocked('p', t0 + PAIR_FAIL_WINDOW_MS + 1)).toBe(false);
  });
});
