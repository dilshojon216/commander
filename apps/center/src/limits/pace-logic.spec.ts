import { describe, expect, it } from 'vitest';
import { DEFAULT_PACE_SETTINGS, PACE_LIMITS, WeeklyPaceSchema, LimitsResponseSchema, paceExceededMessage } from '@commander/contracts';
import type { LimitForecast, LimitWindowView, PaceSettings } from '@commander/contracts';
import { alertToSend, computePace, nextMidnight, paceBlockMessage, resolveDayStart, windowBounds } from './pace-logic.js';

/** Hafta: 2026-11-08T13:00Z (yakshanba 18:00 Toshkent) -> 2026-11-15T13:00Z. Toshkent = UTC+5. */
const RESETS = '2026-11-15T13:00:00.000Z';
const d = (iso: string): Date => new Date(iso);

const forecast = (over: Partial<LimitForecast> = {}): LimitForecast => ({
  exhaustsAt: '2026-11-14T00:00:00.000Z', beforeReset: true, resetsAt: RESETS, ratePctPerHour: 1, basisMinutes: 1440, basisWeightedTokens: 1, confidence: 'medium', source: 'official', ...over,
});
const view = (over: Partial<LimitWindowView> = {}): LimitWindowView => ({
  usedPct: 49.8, resetsAt: RESETS, observedAt: '2026-11-12T06:59:00.000Z', source: 'official', stale: false, ageSeconds: 30, reset: false,
  observedByMachineId: null, anchor: null, calibration: { coefficient: 1e-7, samples: 8 }, forecast: null, ...over,
});
const base = (over: Partial<Parameters<typeof computePace>[0]> = {}): Parameters<typeof computePace>[0] => ({
  now: d('2026-11-12T07:00:00.000Z'), view: view(), dayStart: { pct: 40, from: 'prev_sample' }, settings: DEFAULT_PACE_SETTINGS, overriddenToday: false, alertsToday: { soft: null, hard: null }, ...over,
});

describe('Toshkent kun chegaralari (windowBounds)', () => {
  it('23:59:59 Toshkent hali eski kun, 00:00:00 yangi kun', () => {
    const before = windowBounds(d('2026-11-13T18:59:59.000Z'), d(RESETS));
    const after = windowBounds(d('2026-11-13T19:00:00.000Z'), d(RESETS));
    expect(before.midnight.toISOString()).toBe('2026-11-12T19:00:00.000Z');
    expect(after.midnight.toISOString()).toBe('2026-11-13T19:00:00.000Z');
  });
  it('oyna kun ichida boshlansa kun boshi = oyna boshi; boshqa kunlarda yarim kecha', () => {
    const first = windowBounds(d('2026-11-08T14:00:00.000Z'), d(RESETS));
    expect(first.windowStart.toISOString()).toBe('2026-11-08T13:00:00.000Z');
    expect(first.dayStart.toISOString()).toBe('2026-11-08T13:00:00.000Z');
    const mid = windowBounds(d('2026-11-12T07:00:00.000Z'), d(RESETS));
    expect(mid.dayStart.toISOString()).toBe('2026-11-11T19:00:00.000Z');
  });
  it('keyingi yarim kecha', () => {
    expect(nextMidnight(d('2026-11-12T07:00:00.000Z')).toISOString()).toBe('2026-11-12T19:00:00.000Z');
    expect(nextMidnight(d('2026-11-12T19:00:00.000Z')).toISOString()).toBe('2026-11-13T19:00:00.000Z');
  });
});

describe('kun boshidagi foiz (resolveDayStart)', () => {
  const b = windowBounds(d('2026-11-12T07:00:00.000Z'), d(RESETS)); // yarim kecha 2026-11-11T19:00Z
  const prev = { at: d('2026-11-11T17:00:00.000Z'), pct: 40 };
  const today = { at: d('2026-11-11T19:30:00.000Z'), pct: 41 };
  it('yarim kechadan oldingi kuzatuv ustun', () => {
    expect(resolveDayStart(b, prev, today)).toEqual({ pct: 40, from: 'prev_sample' });
  });
  it('oldingi kuzatuv yo\'q: bugungi birinchisi', () => {
    expect(resolveDayStart(b, null, today)).toEqual({ pct: 41, from: 'first_sample_today' });
  });
  it('oldingi kuzatuv 24 soatdan eski: bugungi birinchisi; bugungisi ham yo\'q bo\'lsa eskisi', () => {
    const old = { at: d('2026-11-09T19:00:00.000Z'), pct: 12 };
    expect(resolveDayStart(b, old, today)).toEqual({ pct: 41, from: 'first_sample_today' });
    expect(resolveDayStart(b, old, null)).toEqual({ pct: 12, from: 'prev_sample' });
  });
  it('hech narsa yo\'q: null (to\'qilmaydi)', () => {
    expect(resolveDayStart(b, null, null)).toBeNull();
  });
  it('oyna kun ichida yangilangan: 0 (kuzatuvlar eski oynaga tegishli bo\'lsa ham)', () => {
    const first = windowBounds(d('2026-11-08T14:00:00.000Z'), d(RESETS));
    expect(resolveDayStart(first, prev, today)).toEqual({ pct: 0, from: 'window_start' });
  });
});

describe('computePace: ulush matematikasi', () => {
  it('hafta o\'rtasi: (100-40)/3,75 kun = 16%, bugun 9,8% = 61,2% ulush', () => {
    const p = computePace(base())!;
    expect(p.remainingDays).toBe(3.75);
    expect(p.allowancePct).toBe(16);
    expect(p.usedTodayPct).toBe(9.8);
    expect(p.pctOfAllowance).toBe(61.2);
    expect(p.dayStartFrom).toBe('prev_sample');
    expect(p.status).toBe('on_track');
    expect(p.onTrack).toBe(true);
    expect(p.source).toBe('official');
    expect(p.resetsAt).toBe(RESETS);
    expect(p.windowStartsAt).toBe('2026-11-08T13:00:00.000Z');
    expect(p.dayStartsAt).toBe('2026-11-11T19:00:00.000Z');
  });
  it('bir tekis tezlik: o\'tgan vaqt / 7 kun', () => {
    // 2026-11-12T07:00Z - 2026-11-08T13:00Z = 3d18h = 90h; 90/168 = 53,57%
    expect(computePace(base())!.expectedPct).toBe(53.57);
  });
  it('oyna boshi: 0%, 7 kun qoldi, ulush 100/7 = 14,29%', () => {
    const p = computePace(base({ now: d('2026-11-08T14:00:00.000Z'), view: view({ usedPct: 1.5 }), dayStart: { pct: 0, from: 'window_start' } }))!;
    expect(p.remainingDays).toBe(7);
    expect(p.allowancePct).toBe(14.29);
    expect(p.pctOfAllowance).toBe(10.5);
    expect(p.expectedPct).toBe(0.6);
    expect(p.dayStartFrom).toBe('window_start');
  });
  it('oyna kun ichida yangilandi: kun boshi = oyna boshi (yarim kecha emas), 0 dan qayta boshlanadi', () => {
    // yangi oyna 2026-11-12T10:00Z da boshlangan: resetsAt = 2026-11-19T10:00Z; hozir 2026-11-12T12:00Z (17:00 Toshkent)
    const p = computePace(base({ now: d('2026-11-12T12:00:00.000Z'), view: view({ usedPct: 3, resetsAt: '2026-11-19T10:00:00.000Z' }), dayStart: { pct: 0, from: 'window_start' } }))!;
    expect(p.dayStartsAt).toBe('2026-11-12T10:00:00.000Z');
    expect(p.remainingDays).toBe(7);
    expect(p.allowancePct).toBe(14.29);
    expect(p.usedTodayPct).toBe(3);
  });
  it('oxirgi qisman kun: kun boshidan resetsAt gacha < 1 kun, ulush qolgan hammasidan oshmaydi', () => {
    // yarim kecha 2026-11-14T19:00Z -> resetsAt 18 soat = 0,75 kun; (100-90)/0,75 = 13,33 -> 10 ga cheklanadi
    const p = computePace(base({ now: d('2026-11-15T12:30:00.000Z'), view: view({ usedPct: 95 }), dayStart: { pct: 90, from: 'prev_sample' } }))!;
    expect(p.remainingDays).toBe(0.75);
    expect(p.allowancePct).toBe(10);
    expect(p.usedTodayPct).toBe(5);
    expect(p.pctOfAllowance).toBe(50);
  });
  it('juda oz vaqt qoldi: qolgan kunlar kamida 1/24 (nolga bo\'lish yo\'q)', () => {
    const p = computePace(base({ now: d('2026-11-14T19:10:00.000Z'), view: view({ usedPct: 70, resetsAt: '2026-11-14T19:30:00.000Z' }), dayStart: { pct: 69, from: 'prev_sample' } }))!;
    expect(p.remainingDays).toBe(0.04);
    expect(Number.isFinite(p.allowancePct)).toBe(true);
    expect(p.allowancePct).toBe(31); // = 100 - 69 (cheklov)
  });
  it('100% dan oshgan: ulush 0, pctOfAllowance 100, exceeded', () => {
    const p = computePace(base({ view: view({ usedPct: 120, source: 'estimate', stale: true }), dayStart: { pct: 110, from: 'prev_sample' } }))!;
    expect(p.allowancePct).toBe(0);
    expect(p.pctOfAllowance).toBe(100);
    expect(p.status).toBe('exceeded');
    expect(p.usedTodayPct).toBe(10);
  });
  it('bugun 100% dan oshib ketsa (kun boshi < 100): ulushning ko\'p foizi, exceeded', () => {
    const p = computePace(base({ view: view({ usedPct: 101 }), dayStart: { pct: 90, from: 'prev_sample' } }))!;
    expect(p.pctOfAllowance).toBeGreaterThan(100);
    expect(p.status).toBe('exceeded');
    expect(p.exhaustAt).toBeNull(); // allaqachon tugagan
  });
  it('kun boshidan keyin foiz pasaysa (rasmiy tuzatish): bugungi sarf manfiy bo\'lmaydi', () => {
    const p = computePace(base({ view: view({ usedPct: 38 }), dayStart: { pct: 40, from: 'prev_sample' } }))!;
    expect(p.usedTodayPct).toBe(0);
    expect(p.dayStartPct).toBe(38);
  });
});

describe('computePace: manba, holat, bashorat', () => {
  it('eskirgan kuzatuv + taxmin: source=estimate va stale ko\'rsatiladi (CLAUDE.md #6)', () => {
    const p = computePace(base({ view: view({ source: 'estimate', stale: true }) }))!;
    expect(p.source).toBe('estimate');
    expect(p.stale).toBe(true);
  });
  it('eskirgan, kalibrlashsiz (rasmiy qiymat): source=official, stale=true', () => {
    const p = computePace(base({ view: view({ source: 'official', stale: true }) }))!;
    expect(p.source).toBe('official');
    expect(p.stale).toBe(true);
  });
  it('holat: 80% dan tez, 100% dan exceeded', () => {
    expect(computePace(base({ view: view({ usedPct: 52.8 }) }))!.status).toBe('fast'); // 12,8/16 = 80%
    expect(computePace(base({ view: view({ usedPct: 56 }) }))!.status).toBe('exceeded'); // 16/16
  });
  it('bashorat resetsAt dan oldin tugasa "fast", past ishonchli bashorat holatni o\'zgartirmaydi', () => {
    expect(computePace(base({ view: view({ forecast: forecast() }) }))!.status).toBe('fast');
    expect(computePace(base({ view: view({ forecast: forecast({ confidence: 'low' }) }) }))!.status).toBe('on_track');
    expect(computePace(base({ view: view({ forecast: forecast({ beforeReset: false, exhaustsAt: '2026-11-20T00:00:00.000Z' }) }) }))!.status).toBe('on_track');
  });
  it('3.1 bashorati qayta ishlatiladi: exhaustAt va exhaustBeforeReset', () => {
    const p = computePace(base({ view: view({ forecast: forecast() }) }))!;
    expect(p.exhaustAt).toBe('2026-11-14T00:00:00.000Z');
    expect(p.exhaustBeforeReset).toBe(true);
    const none = computePace(base())!;
    expect(none.exhaustAt).toBeNull();
    expect(none.exhaustBeforeReset).toBeNull();
  });
  it('ma\'lumot yo\'q/yaroqsiz: null', () => {
    expect(computePace(base({ view: null }))).toBeNull();
    expect(computePace(base({ dayStart: null }))).toBeNull();
    expect(computePace(base({ view: view({ resetsAt: null }) }))).toBeNull();
    expect(computePace(base({ view: view({ resetsAt: '2026-11-12T06:00:00.000Z' }) }))).toBeNull(); // reset allaqachon o'tgan
  });
  it('javob sxemasiga mos va LimitsResponse additiv maydon sifatida o\'tadi', () => {
    const p = computePace(base({ view: view({ forecast: forecast() }) }))!;
    expect(WeeklyPaceSchema.safeParse(p).success).toBe(true);
    const resp = { computedAt: '2026-11-12T07:00:00.000Z', freshSeconds: 180, fiveHour: null, sevenDay: view(), pace: p };
    expect(LimitsResponseSchema.safeParse(resp).success).toBe(true);
    expect(LimitsResponseSchema.safeParse({ ...resp, pace: undefined }).success).toBe(true);
    expect(LimitsResponseSchema.safeParse({ ...resp, pace: null }).success).toBe(true);
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['dayStartPct', 'allowancePct', 'usedTodayPct', 'pctOfAllowance', 'expectedPct', 'onTrack', 'exhaustAt', 'resetsAt', 'source']));
  });
});

describe('majburlash (blocked) va "bugun uchun ruxsat"', () => {
  const enforce: PaceSettings = { ...DEFAULT_PACE_SETTINGS, enforce: true };
  const over = { view: view({ usedPct: 56 }) }; // 100% ulush
  it('default (enforce o\'chiq): hech qachon bloklamaydi', () => {
    expect(computePace(base(over))!.blocked).toBe(false);
    expect(paceBlockMessage(computePace(base(over)))).toBeNull();
  });
  it('enforce yoqiq va ulush tugagan: blocked + o\'zbekcha sabab matni', () => {
    const p = computePace(base({ ...over, settings: enforce }))!;
    expect(p.blocked).toBe(true);
    const msg = paceBlockMessage(p)!;
    expect(msg).toContain('Haftalik limitning bugungi ulushi tugadi');
    expect(msg).toContain('16,0%');
    expect(msg).not.toContain('≈');
  });
  it('taxmin bo\'lsa matn "taxmin, rasmiy emas" deydi', () => {
    const p = computePace(base({ view: view({ usedPct: 56, source: 'estimate', stale: true }), settings: enforce }))!;
    expect(paceBlockMessage(p)).toContain('taxmin, rasmiy emas');
    expect(paceExceededMessage({ allowancePct: 16, usedTodayPct: 16, estimate: true })).toContain('≈16,0%');
  });
  it('ulush tugamagan: bloklamaydi; ruxsat berilgan: bloklamaydi; o\'chirilgan: bloklamaydi', () => {
    expect(computePace(base({ settings: enforce }))!.blocked).toBe(false);
    expect(computePace(base({ ...over, settings: enforce, overriddenToday: true }))!.blocked).toBe(false);
    expect(computePace(base({ ...over, settings: { ...enforce, enabled: false } }))!.blocked).toBe(false);
    expect(computePace(base({ ...over, settings: enforce, overriddenToday: true }))!.overriddenToday).toBe(true);
  });
  it('maxsus chegara: hardPct 150 bo\'lsa 100% da hali ruxsat', () => {
    expect(computePace(base({ ...over, settings: { ...enforce, hardPct: 150 } }))!.blocked).toBe(false);
  });
});

describe('ogohlantirish (alertToSend): kuniga har daraja bir marta', () => {
  const at = (pct: number, over: Partial<PaceSettings> = {}, extra: { usedPct?: number } = {}) => computePace(base({ view: view({ usedPct: extra.usedPct ?? 40 + (16 * pct) / 100 }), settings: { ...DEFAULT_PACE_SETTINGS, ...over } }))!;
  it('80% dan past: yo\'q; 80%: soft; takror yo\'q; 100%: hard; takror yo\'q', () => {
    expect(alertToSend(at(50), new Set())).toEqual({ send: null, mark: [] });
    expect(alertToSend(at(80), new Set())).toEqual({ send: 'soft', mark: ['soft'] });
    expect(alertToSend(at(85), new Set(['soft']))).toEqual({ send: null, mark: [] });
    expect(alertToSend(at(100), new Set(['soft']))).toEqual({ send: 'hard', mark: ['hard'] });
    expect(alertToSend(at(120), new Set(['soft', 'hard']))).toEqual({ send: null, mark: [] });
  });
  it('okdan to\'g\'ridan-to\'g\'ri 100% ga sakrash: faqat hard yuboriladi, soft ham belgilanadi', () => {
    expect(alertToSend(at(105), new Set())).toEqual({ send: 'hard', mark: ['soft', 'hard'] });
  });
  it('hard allaqachon yuborilgan bo\'lsa soft qayta yuborilmaydi', () => {
    expect(alertToSend(at(80), new Set(['hard']))).toEqual({ send: null, mark: [] });
  });
  it('o\'chirilgan sozlama, null pace va juda kichik ulush (< 1%) ogohlantirmaydi', () => {
    expect(alertToSend(at(100, { enabled: false }), new Set())).toEqual({ send: null, mark: [] });
    expect(alertToSend(null, new Set())).toEqual({ send: null, mark: [] });
    const tiny = computePace(base({ now: d('2026-11-15T12:30:00.000Z'), view: view({ usedPct: 99.6 }), dayStart: { pct: 99.5, from: 'prev_sample' } }))!;
    expect(tiny.allowancePct).toBeLessThan(PACE_LIMITS.minAlertAllowancePct);
    expect(alertToSend(tiny, new Set())).toEqual({ send: null, mark: [] });
  });
  it('maxsus chegaralar ishlatiladi', () => {
    expect(alertToSend(at(60, { softPct: 50, hardPct: 90 }), new Set()).send).toBe('soft');
    expect(alertToSend(at(95, { softPct: 50, hardPct: 90 }), new Set()).send).toBe('hard');
  });
});
