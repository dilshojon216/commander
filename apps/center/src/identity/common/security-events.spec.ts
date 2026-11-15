import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { FailureAggregator } from '../audit/failure-aggregator.js';
import { clientKey, requestIp } from './request-context.js';
import { AUTH_FAIL_LIMIT, SecurityEvents } from './security-events.service.js';

const req = (peer: string, xff?: string): Request =>
  ({ method: 'GET', originalUrl: '/v1/x', socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as Request;

const events = (): SecurityEvents => new SecurityEvents({ note: () => undefined } as unknown as FailureAggregator);

describe('M-08: auth-failure limiter mijoz bo\'yicha', () => {
  it('XFF: faqat ishonchli proksi (loopback/private) ortida va OXIRGI qiymat; mijoz yozgan birinchi qiymat soxtalashtira olmaydi', () => {
    expect(requestIp(req('127.0.0.1', '100.64.0.9'))).toBe('100.64.0.9');
    expect(requestIp(req('172.20.0.1', '6.6.6.6, 100.64.0.9'))).toBe('100.64.0.9');
    expect(requestIp(req('203.0.113.7', '100.64.0.9'))).toBe('203.0.113.7'); // ochiq peer: XFF e'tiborsiz
    expect(clientKey(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientKey(req('127.0.0.1', 'not-an-ip'))).toBe('127.0.0.1');
  });

  it("bitta buzilgan tailnet qurilmasi qulflanadi, boshqa mijoz (dashboard/mobil) 429 olmaydi", () => {
    const ev = events();
    const bad = req('127.0.0.1', '100.64.0.66');
    for (let i = 0; i < AUTH_FAIL_LIMIT; i += 1) ev.authFailed(bad, { scheme: 'bearer', reason: 'invalid' });
    expect(() => ev.assertAuthNotFlooded(bad, 'd:unknown')).toThrow();
    expect(() => ev.assertAuthNotFlooded(req('127.0.0.1', '100.64.0.10'), 't:other')).not.toThrow();
    expect(() => ev.assertAuthNotFlooded(req('127.0.0.1'))).not.toThrow();
  });

  it("qulflangan mijozdan ham yaqinda muvaffaqiyatli o'tgan token/qurilma tekshiriladi (qulf yo'q)", () => {
    const ev = events();
    const flooded = req('127.0.0.1', '100.64.0.66');
    const id = SecurityEvents.bearerId('cmdr_valid_token_value');
    ev.markValid(id);
    ev.markValid('d:11111111-1111-4111-8111-111111111111');
    for (let i = 0; i < AUTH_FAIL_LIMIT; i += 1) ev.authFailed(flooded, { scheme: 'bearer', reason: 'invalid' });
    expect(() => ev.assertAuthNotFlooded(flooded, id)).not.toThrow();
    expect(() => ev.assertAuthNotFlooded(flooded, 'd:11111111-1111-4111-8111-111111111111')).not.toThrow();
    expect(() => ev.assertAuthNotFlooded(flooded, SecurityEvents.bearerId('cmdr_random_guess'))).toThrow();
    expect(() => ev.assertAuthNotFlooded(flooded)).toThrow();
  });

  it('recent-valid TTL tugagach qulf qayta ishlaydi; WS handshake ham mijoz kaliti bo\'yicha', () => {
    const ev = events();
    const flooded = req('127.0.0.1', '100.64.0.66');
    ev.markValid('t:abc', 1_000);
    expect(ev.isRecentlyValid('t:abc', 1_000 + 599_999)).toBe(true);
    expect(ev.isRecentlyValid('t:abc', 1_000 + 600_001)).toBe(false);
    for (let i = 0; i < AUTH_FAIL_LIMIT; i += 1) ev.wsAuthFailed(flooded as never, { reason: 'unauthorized' });
    expect(ev.isWsAuthFlooded(flooded as never)).toBe(true);
    expect(ev.isWsAuthFlooded(req('127.0.0.1', '100.64.0.10') as never)).toBe(false);
  });
});
