import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { FailureAggregator } from './audit/failure-aggregator.js';
import type { AuditRecord, AuditService } from './audit/audit.service.js';
import { REDACTED, sanitizeAuditDetails } from './audit/redact.js';
import {
  decodeRawEd25519PublicKey,
  generateClientToken,
  generateEnrollmentCode,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
} from './common/crypto.util.js';
import { FixedWindowLimiter } from './common/rate-limiter.js';
import { hasScopes } from './tokens/client-token.guard.js';

describe('crypto util', () => {
  it('enrollment code: 8 chars Crockford, normalization is case/dash/ambiguity insensitive', () => {
    const code = generateEnrollmentCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(hashEnrollmentCode(code)).toBe(hashEnrollmentCode(code.toLowerCase().replace('-', ' ')));
    expect(normalizeEnrollmentCode('o0il-lI')).toBe('001111'.slice(0, 0) + '00111' + '1');
    expect(new Set(Array.from({ length: 200 }, generateEnrollmentCode)).size).toBe(200);
  });

  it('client token: cmdr_ + 43 base64url chars', () => {
    expect(generateClientToken()).toMatch(/^cmdr_[A-Za-z0-9_-]{43}$/);
  });

  it('public key decoding: raw 32 bytes only (base64url and base64), no SPKI, no zero key, canonical encoding', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    expect(decodeRawEd25519PublicKey(raw.toString('base64url'))?.equals(raw)).toBe(true);
    expect(decodeRawEd25519PublicKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(decodeRawEd25519PublicKey(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))).toBeNull();
    expect(decodeRawEd25519PublicKey(Buffer.alloc(32).toString('base64url'))).toBeNull();
    // oxirgi belgi bitlari noldan farqli (kanonik emas)
    const s = raw.toString('base64url');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = s.slice(0, -1) + chars[(chars.indexOf(s.slice(-1)) & ~3) | 1]; // 43-belgili kodlashda oxirgi 2 bit nol bo'lishi shart
    expect(decodeRawEd25519PublicKey(alt)).toBeNull();
  });
});

describe('audit redaction', () => {
  it('redacts secret keys and token-looking values, truncates long strings, drops functions', () => {
    const out = sanitizeAuditDetails({
      code: 'ABCD-EFGH', enrollment_code: 'x', token: 't', signature: 's', Authorization: 'Bearer abcdefghijkl',
      nested: { password: 'p', ok: 1, deep: { api_key: 'k' } },
      note: 'cmdr_' + 'a'.repeat(43),
      http_status: 401, status_code_text: 'fine',
      long: 'x'.repeat(1000), fn: () => 1,
    });
    expect(out.code).toBe(REDACTED);
    expect(out.enrollment_code).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.signature).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    expect(out.nested).toEqual({ password: REDACTED, ok: 1, deep: { api_key: REDACTED } });
    expect(out.note).toBe(REDACTED);
    expect(out.http_status).toBe(401);
    expect(String(out.long).length).toBeLessThan(310);
    expect('fn' in out).toBe(false);
  });
});

describe('FixedWindowLimiter', () => {
  it('blocks after the limit within the window and recovers after it', () => {
    const l = new FixedWindowLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.hit('k', 0);
    expect(l.isBlocked('k', 10)).toBe(true);
    expect(l.isBlocked('other', 10)).toBe(false);
    expect(l.retryAfterSeconds('k', 10)).toBe(1);
    expect(l.isBlocked('k', 1001)).toBe(false);
  });
  it('bounds memory', () => {
    const l = new FixedWindowLimiter(1, 1_000_000, 100);
    for (let i = 0; i < 1000; i++) l.hit(`k${i}`, 0);
    expect((l as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});

describe('FailureAggregator', () => {
  const setup = (opts = {}) => {
    const rows: AuditRecord[] = [];
    const audit = { record: vi.fn(async (r: AuditRecord) => void rows.push(r)) } as unknown as AuditService;
    const agg = new FailureAggregator(audit);
    agg.configure({ windowMs: 1000, maxRowsPerWindow: 3, maxKeys: 10, ...opts });
    return { agg, rows };
  };
  const rec = (n: string): AuditRecord => ({ actorKind: 'system', action: 'auth.failed', details: { n } });
  const settle = () => new Promise((r) => setImmediate(r));

  it('writes the first failure immediately and folds the rest into one counted row per window', async () => {
    const { agg, rows } = setup();
    for (let i = 0; i < 100; i++) agg.note('k', rec('a'), 0 + i);
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ count: 1 });
    agg.flush(1500);
    await settle();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.details).toMatchObject({ count: 99 });
    agg.onModuleDestroy();
  });

  it('caps rows per window across keys; the surplus goes into a single overflow row', async () => {
    const { agg, rows } = setup();
    for (let k = 0; k < 50; k++) agg.note(`k${k}`, rec(String(k)), 10);
    await settle();
    expect(rows.filter((r) => r.action === 'auth.failed')).toHaveLength(3);
    expect(rows.filter((r) => r.action === 'audit.overflow')).toHaveLength(1);
    agg.flush(2000); // oyna tugadi: bostirilgan sanoqlar yoziladi (overflow ham)
    await settle();
    expect(rows.length).toBeLessThanOrEqual(3 + 2 + 3);
    const total = rows.reduce((n, r) => n + Number((r.details as { count: number }).count), 0);
    expect(total).toBe(50);
    agg.onModuleDestroy();
  });
});

describe('scopes', () => {
  it('flat scopes; admin covers everything', () => {
    expect(hasScopes(['read'], ['read'])).toBe(true);
    expect(hasScopes(['read'], ['approve'])).toBe(false);
    expect(hasScopes(['control'], ['read'])).toBe(false);
    expect(hasScopes(['admin'], ['control', 'approve'])).toBe(true);
  });
});
