import { describe, expect, it } from 'vitest';
import { AGENT_WS_CLOSE } from '@commander/contracts';
import { backoffDelay, decideReconnect } from './reconnect-policy.js';

describe('decideReconnect (center close-kod semantikasi)', () => {
  it('4010 va 4009: qayta ulanmaydi', () => {
    expect(decideReconnect(AGENT_WS_CLOSE.revoked).action).toBe('stop');
    expect(decideReconnect(AGENT_WS_CLOSE.replaced).action).toBe('stop');
  });

  it('1001: darhol', () => {
    expect(decideReconnect(AGENT_WS_CLOSE.goingAway)).toEqual({ action: 'immediate' });
  });

  it('4001/4002/4011/4008: backoff', () => {
    for (const code of [AGENT_WS_CLOSE.authFailed, AGENT_WS_CLOSE.authTimeout, AGENT_WS_CLOSE.heartbeatTimeout, AGENT_WS_CLOSE.rateLimited]) {
      expect(decideReconnect(code).action).toBe('backoff');
    }
    const rate = decideReconnect(AGENT_WS_CLOSE.rateLimited);
    expect(rate.action === 'backoff' && rate.minDelayMs).toBeGreaterThanOrEqual(30_000);
  });

  it('4003/1009 (bug) va tarmoq xatosi (1006): backoff', () => {
    const proto = decideReconnect(AGENT_WS_CLOSE.protocolError);
    expect(proto.action === 'backoff' && proto.minDelayMs).toBeGreaterThanOrEqual(60_000);
    expect(decideReconnect(1006)).toEqual({ action: 'backoff', minDelayMs: 0 });
  });
});

describe('backoffDelay', () => {
  it('exponential o\'sadi va maxMs bilan cheklanadi (jitter oralig\'ida)', () => {
    const lo = (a: number) => backoffDelay(a, { random: () => 0 });
    const hi = (a: number) => backoffDelay(a, { random: () => 0.999999 });
    expect(lo(0)).toBe(500);
    expect(hi(0)).toBe(1000);
    expect(lo(3)).toBe(4000);
    expect(hi(3)).toBe(8000);
    expect(hi(20)).toBe(60_000);
    expect(lo(20)).toBe(30_000);
  });

  it('har doim [cap/2, cap] ichida', () => {
    for (let a = 0; a < 12; a++) {
      const cap = Math.min(60_000, 1000 * 2 ** a);
      for (let i = 0; i < 20; i++) {
        const d = backoffDelay(a);
        expect(d).toBeGreaterThanOrEqual(Math.floor(cap / 2));
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
  });
});
