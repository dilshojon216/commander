import { describe, expect, it } from 'vitest';
import {
  FIVE_HOUR_MS,
  FRESH_SECONDS,
  SEVEN_DAY_MS,
  computeWindowView,
  fitCalibration,
  nextResetInstant,
  nextWeeklyReset,
  rollWindowAfterReset,
  weightedTokens,
} from './limits-logic.js';
import type { CalibrationPoint, OfficialObservation, UsageBucket } from './limits-logic.js';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);
const MIN = 60_000;
const M = '0d9e6c0a-9d3c-4f6a-8e0f-1a2b3c4d5e6f';

const obs = (over: Partial<OfficialObservation> = {}): OfficialObservation => ({ observedAt: at(0), usedPct: 40, resetsAt: at(3 * 3_600_000), machineId: M, ...over });
const calib = (coefficient: number | null, samples = coefficient === null ? 0 : 3) => ({ coefficient, samples });

describe('weightedTokens', () => {
  it('weights output highest and cache_read lowest (PLAN 6.3)', () => {
    expect(weightedTokens({ input: 100, output: 100, cacheRead: 100, cacheCreation: 100 })).toBe(100 + 500 + 10 + 125);
    expect(weightedTokens({ input: 0, output: 0, cacheRead: 1000, cacheCreation: 0 })).toBe(100);
  });
});

describe('fitCalibration', () => {
  const pt = (offsetMin: number, usedPct: number, weightedSincePrev: number | null, resetsAt = at(3 * 3_600_000)): CalibrationPoint => ({
    observedAt: at(offsetMin * MIN),
    usedPct,
    resetsAt,
    weightedSincePrev,
  });

  it('needs at least one usable pair: no coefficient from a single observation', () => {
    expect(fitCalibration([])).toEqual({ coefficient: null, samples: 0 });
    expect(fitCalibration([pt(0, 10, null)])).toEqual({ coefficient: null, samples: 0 });
  });

  it('coefficient = sum(dPct) / sum(weighted tokens) over usable pairs', () => {
    const c = fitCalibration([pt(0, 10, null), pt(10, 12, 1000), pt(20, 15, 2000)]);
    expect(c.samples).toBe(2);
    expect(c.coefficient).toBeCloseTo(5 / 3000, 10);
  });

  it('skips pairs with no pct increase, no tokens, or a different window (reset in between)', () => {
    const other = at(9 * 3_600_000);
    const c = fitCalibration([
      pt(0, 10, null),
      pt(5, 10, 500), // pct o'smadi
      pt(10, 20, 0), // token yo'q
      pt(15, 3, 400, other), // boshqa oyna
      pt(20, 6, 300, other), // shu oyna: dPct=3, w=300
    ]);
    expect(c.samples).toBe(1);
    expect(c.coefficient).toBeCloseTo(3 / 300, 10);
  });

  it('input order does not matter; only the most recent 20 pairs count', () => {
    const pts: CalibrationPoint[] = [pt(0, 0, null)];
    for (let i = 1; i <= 30; i += 1) pts.push(pt(i, i, i <= 10 ? 1 : 100));
    const shuffled = [...pts].reverse();
    const c = fitCalibration(shuffled);
    expect(c.samples).toBe(20);
    expect(c.coefficient).toBeCloseTo(1 / 100, 10); // eski, boshqa nisbatli juftliklar chiqib ketdi
  });
});

describe('nextWeeklyReset', () => {
  it('rolls the anchor forward in 7-day steps to the first instant after now', () => {
    const anchor = at(-3 * 24 * 3_600_000);
    expect(nextWeeklyReset(anchor, at(0)).getTime()).toBe(anchor.getTime() + SEVEN_DAY_MS);
    expect(nextWeeklyReset(anchor, at(10 * 24 * 3_600_000)).getTime()).toBe(anchor.getTime() + 2 * SEVEN_DAY_MS);
    expect(nextWeeklyReset(at(1000), at(0)).getTime()).toBe(T0 + 1000); // hali kelmagan: o'zi
    expect(nextWeeklyReset(at(0), at(0)).getTime()).toBe(T0 + SEVEN_DAY_MS); // aynan chegarada: keyingisi
  });
});

describe('rollWindowAfterReset (5h)', () => {
  const b = (offsetMin: number, weighted: number): UsageBucket => ({ t: at(offsetMin * MIN), weighted });
  const reset = at(-60 * MIN); // 1 soat oldin reset bo'lgan

  it('no usage since the reset: 0, resetsAt unknown', () => {
    expect(rollWindowAfterReset('fiveHour', reset, [], at(0))).toEqual({ start: null, resetsAt: null, weighted: 0 });
  });

  it('the new window starts at the first usage after the reset and lasts 5h', () => {
    const w = rollWindowAfterReset('fiveHour', reset, [b(-30, 100), b(-20, 50), b(-5, 25)], at(0));
    expect(w.start?.getTime()).toBe(at(-30 * MIN).getTime());
    expect(w.resetsAt?.getTime()).toBe(at(-30 * MIN).getTime() + FIVE_HOUR_MS);
    expect(w.weighted).toBe(175);
  });

  it('usage before the reset is ignored', () => {
    const w = rollWindowAfterReset('fiveHour', reset, [b(-120, 9999), b(-10, 10)], at(0));
    expect(w.weighted).toBe(10);
  });

  it('a window that already ended and was followed by a gap is 0% again; a later burst starts a new window', () => {
    const longAgo = at(-20 * 3_600_000);
    const ended = rollWindowAfterReset('fiveHour', longAgo, [b(-19 * 60, 100)], at(0));
    expect(ended).toEqual({ start: null, resetsAt: null, weighted: 0 });
    const newer = rollWindowAfterReset('fiveHour', longAgo, [b(-19 * 60, 100), b(-30, 40), b(-10, 10)], at(0));
    expect(newer.start?.getTime()).toBe(at(-30 * MIN).getTime());
    expect(newer.weighted).toBe(50);
  });
});

describe('rollWindowAfterReset (7d)', () => {
  it('window start = next weekly reset - 7d; counts usage since then', () => {
    const anchor = at(-8 * 24 * 3_600_000); // 8 kun oldin reset => hozirgi hafta 1 kun oldin boshlangan
    const buckets: UsageBucket[] = [
      { t: at(-2 * 24 * 3_600_000), weighted: 1000 }, // oldingi haftada
      { t: at(-12 * 3_600_000), weighted: 40 },
      { t: at(-1 * 3_600_000), weighted: 60 },
    ];
    const w = rollWindowAfterReset('sevenDay', anchor, buckets, at(0));
    expect(w.start?.getTime()).toBe(anchor.getTime() + SEVEN_DAY_MS);
    expect(w.resetsAt?.getTime()).toBe(anchor.getTime() + 2 * SEVEN_DAY_MS);
    expect(w.weighted).toBe(100);
  });
});

describe('computeWindowView', () => {
  const base = { kind: 'fiveHour' as const, now: at(0), calibration: calib(0.001), weightedSinceObserved: 0, bucketsSinceReset: [] as UsageBucket[] };

  it('no official observation -> null (never invents a number)', () => {
    expect(computeWindowView({ ...base, latest: null })).toBeNull();
  });

  it('fresh official observation is reported as official, not stale', () => {
    const v = computeWindowView({ ...base, latest: obs({ observedAt: at(-30_000), usedPct: 41.234 }), weightedSinceObserved: 5000 })!;
    expect(v).toMatchObject({ usedPct: 41.23, source: 'official', stale: false, reset: false, ageSeconds: 30, observedByMachineId: M });
    expect(v.resetsAt).toBe(at(3 * 3_600_000).toISOString());
    expect(v.observedAt).toBe(at(-30_000).toISOString());
  });

  it('stale + tokens since + calibration -> estimate (anchor + coefficient * weighted), still flagged stale', () => {
    const v = computeWindowView({ ...base, latest: obs({ observedAt: at(-30 * MIN), usedPct: 40 }), weightedSinceObserved: 5000, calibration: calib(0.002) })!;
    expect(v.source).toBe('estimate');
    expect(v.stale).toBe(true);
    expect(v.usedPct).toBe(50); // 40 + 0.002*5000
    expect(v.anchor).toEqual({ usedPct: 40, resetsAt: at(3 * 3_600_000).toISOString(), observedAt: at(-30 * MIN).toISOString() });
    expect(v.calibration).toEqual({ coefficient: 0.002, samples: 3 });
  });

  it('stale but no calibration (or no tokens since): stays the stale OFFICIAL value, no extrapolation', () => {
    const noCal = computeWindowView({ ...base, latest: obs({ observedAt: at(-30 * MIN) }), weightedSinceObserved: 5000, calibration: calib(null) })!;
    expect(noCal).toMatchObject({ source: 'official', stale: true, usedPct: 40 });
    const noTokens = computeWindowView({ ...base, latest: obs({ observedAt: at(-30 * MIN) }), weightedSinceObserved: 0 })!;
    expect(noTokens).toMatchObject({ source: 'official', stale: true, usedPct: 40 });
  });

  it('freshness boundary: exactly FRESH_SECONDS is fresh, one more second is stale', () => {
    expect(computeWindowView({ ...base, latest: obs({ observedAt: at(-FRESH_SECONDS * 1000) }) })!.stale).toBe(false);
    expect(computeWindowView({ ...base, latest: obs({ observedAt: at(-(FRESH_SECONDS + 1) * 1000) }) })!.stale).toBe(true);
  });

  it('resetsAt passed: reported as a reset, source=estimate, 0% without calibration', () => {
    const latest = obs({ observedAt: at(-6 * 3_600_000), usedPct: 93, resetsAt: at(-MIN) });
    const v = computeWindowView({ ...base, latest, calibration: calib(null) })!;
    expect(v).toMatchObject({ usedPct: 0, source: 'estimate', reset: true, resetsAt: null });
    expect(v.anchor?.usedPct).toBe(93); // asos ko'rinib turadi, lekin qiymat 93 emas
  });

  it('resetsAt passed + calibration + usage since: estimate for the NEW window with its own reset time', () => {
    const latest = obs({ observedAt: at(-6 * 3_600_000), usedPct: 93, resetsAt: at(-60 * MIN) });
    const buckets: UsageBucket[] = [{ t: at(-30 * MIN), weighted: 4000 }, { t: at(-5 * MIN), weighted: 1000 }];
    const v = computeWindowView({ ...base, latest, calibration: calib(0.004), bucketsSinceReset: buckets })!;
    expect(v).toMatchObject({ source: 'estimate', reset: true });
    expect(v.usedPct).toBe(20); // 0.004 * 5000
    expect(v.resetsAt).toBe(new Date(at(-30 * MIN).getTime() + FIVE_HOUR_MS).toISOString());
  });

  it('weekly reset: rolls to the next weekly boundary', () => {
    const latest = obs({ observedAt: at(-8 * 24 * 3_600_000), usedPct: 95, resetsAt: at(-24 * 3_600_000) });
    const v = computeWindowView({ ...base, kind: 'sevenDay', latest, calibration: calib(null) })!;
    expect(v).toMatchObject({ usedPct: 0, source: 'estimate', reset: true });
    expect(v.resetsAt).toBe(at(6 * 24 * 3_600_000).toISOString());
  });

  it('a reset window never reports the old official percentage as official', () => {
    const v = computeWindowView({ ...base, latest: obs({ resetsAt: at(0) }) })!; // aynan hozir
    expect(v.source).toBe('estimate');
    expect(v.reset).toBe(true);
  });

  it('estimates are capped at 1000%', () => {
    const v = computeWindowView({ ...base, latest: obs({ observedAt: at(-30 * MIN), usedPct: 900 }), weightedSinceObserved: 1e9, calibration: calib(1) })!;
    expect(v.usedPct).toBe(1000);
  });
});

describe('nextResetInstant', () => {
  it('picks the earliest future resetsAt, ignores nulls and past values', () => {
    const view = (resetsAt: string | null) => ({ resetsAt }) as never;
    expect(nextResetInstant([null, view(null)], at(0))).toBeNull();
    const a = at(2 * 3_600_000).toISOString();
    const b = at(1 * 3_600_000).toISOString();
    const past = at(-1000).toISOString();
    expect(nextResetInstant([view(a), view(b), view(past)], at(0))?.toISOString()).toBe(b);
  });
});
