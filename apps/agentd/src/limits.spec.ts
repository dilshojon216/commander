import { describe, expect, it } from 'vitest';
import { LIMITS_KEEPALIVE_MS, LimitsThrottle, resetsAtToMs } from './limits.js';

const input = (five: number | null, seven: number, sid = 's1') => ({
  session_id: sid,
  rate_limits: {
    ...(five === null ? {} : { five_hour: { used_percentage: five, resets_at: 1800000000 } }),
    seven_day: { used_percentage: seven, resets_at: 1800500000 },
  },
});

describe('resetsAtToMs', () => {
  it('sekundni ms ga o\'giradi; ms bo\'lsa o\'zgartirmaydi', () => {
    expect(resetsAtToMs(1800000000)).toBe(1800000000000);
    expect(resetsAtToMs(1800000000000)).toBe(1800000000000);
  });
});

describe('LimitsThrottle', () => {
  it("birinchi kuzatuv darhol chiqadi; resetsAt ms; observedAt = kuzatuv vaqti", () => {
    const t = new LimitsThrottle();
    const out = t.observe(input(40, 10), 1000);
    expect(out).toEqual({
      fiveHour: { usedPct: 40, resetsAt: 1800000000000 },
      sevenDay: { usedPct: 10, resetsAt: 1800500000000 },
      claudeSessionId: 's1',
      observedAt: 1000,
    });
  });

  it("o'zgarishsiz kuzatuv keep-alive (2 daqiqa) ichida yuborilmaydi", () => {
    const t = new LimitsThrottle();
    t.observe(input(40, 10), 1000);
    expect(t.observe(input(40, 10), 100_000)).toBeNull();
    expect(t.hasPending()).toBe(false);
  });

  it("o'zgarmagan qiymat keep-alive o'tgach yangi observedAt bilan qayta yuboriladi (markazda eskirmasin)", () => {
    const t = new LimitsThrottle();
    t.observe(input(40, 10), 1000);
    const out = t.observe(input(40, 10), 1000 + LIMITS_KEEPALIVE_MS);
    expect(out).toMatchObject({ sevenDay: { usedPct: 10 }, observedAt: 1000 + LIMITS_KEEPALIVE_MS });
    expect(t.observe(input(40, 10), 1000 + LIMITS_KEEPALIVE_MS + 5_000)).toBeNull();
  });

  it("o'zgarish 30 s dan tez emas yuboriladi; kutish davomida oxirgi qiymat va uning observedAt'i", () => {
    const t = new LimitsThrottle();
    t.observe(input(40, 10), 1000);
    expect(t.observe(input(41, 10), 5000)).toBeNull();
    expect(t.observe(input(42, 10), 9000)).toBeNull();
    expect(t.hasPending()).toBe(true);
    expect(t.flush(20_000)).toBeNull();
    const out = t.flush(31_000);
    expect(out?.fiveHour?.usedPct).toBe(42);
    expect(out?.observedAt).toBe(9000);
    expect(t.hasPending()).toBe(false);
    // chiqgan qiymat qayta o'zgarish emas
    expect(t.observe(input(42, 10), 40_000)).toBeNull();
  });

  it("five_hour yo'q bo'lsa faqat sevenDay yuboriladi", () => {
    const out = new LimitsThrottle().observe(input(null, 5), 1);
    expect(out?.fiveHour).toBeUndefined();
    expect(out?.sevenDay?.usedPct).toBe(5);
  });

  it("rate_limits yo'q yoki yaroqsiz kirish e'tiborsiz", () => {
    const t = new LimitsThrottle();
    expect(t.observe({ session_id: 's' }, 1)).toBeNull();
    expect(t.observe('garbage', 1)).toBeNull();
    expect(t.observe({ rate_limits: {} }, 1)).toBeNull();
  });
});
