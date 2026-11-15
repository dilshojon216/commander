import { PACE_LIMITS, paceExceededMessage } from '@commander/contracts';
import type { LimitWindowView, PaceDayStartSource, PaceSettings, PaceStatus, WeeklyPace } from '@commander/contracts';
import { tashkentDayStart, tashkentDayOf } from '../projects/tashkent-day.js';
import { SAME_WINDOW_TOLERANCE_MS, SEVEN_DAY_MS } from './limits-logic.js';

/**
 * Haftalik limit tezligi sof mantig'i (6.12). DB va soat tashqaridan beriladi. Ta'riflar: `libs/contracts/src/limits-pace.ts`.
 *
 * Kun boshidagi foiz (`resolveDayStart`), ustuvorlik tartibida:
 *  1. oyna kun ichida boshlangan (`windowStart >= Toshkent yarim kechasi`) -> 0, `window_start`;
 *  2. yarim kechadan OLDINGI eng yaqin shu oynadagi rasmiy kuzatuv (yoshi `prevSampleMaxAgeMs` dan oshmasa) -> `prev_sample`:
 *     tunda yig'ilgan sarf bugunga yoziladi (kuzatuv faqat sessiya ishlaganda keladi, shuning uchun "bugungi" sarf
 *     oldingi kuzatuvdan beri hammasi: xavfsiz, ya'ni kamsitmaydigan tomon);
 *  3. aks holda bugungi BIRINCHI shu oynadagi rasmiy kuzatuv -> `first_sample_today` (undan oldingi bugungi sarf ko'rinmaydi);
 *  4. eskirgan oldingi kuzatuv bor-u, bugungisi yo'q -> oldingisi (`prev_sample`);
 *  5. hech narsa yo'q -> null (pace hisoblanmaydi: to'qilmaydi).
 */

const DAY_MS = 86_400_000;

export interface SamplePoint {
  /** Kuzatuv vaqti. */
  at: Date;
  pct: number;
}

export interface DayStart {
  pct: number;
  from: PaceDayStartSource;
}

export interface WindowBounds {
  windowStart: Date;
  resetsAt: Date;
  /** Toshkent kalendar kuni boshi (yarim kecha). */
  midnight: Date;
  /** Hisoblangan kun boshi: `max(midnight, windowStart)`. */
  dayStart: Date;
}

export function windowBounds(now: Date, resetsAt: Date): WindowBounds {
  const windowStart = new Date(resetsAt.getTime() - SEVEN_DAY_MS);
  const midnight = tashkentDayStart(tashkentDayOf(now));
  return { windowStart, resetsAt, midnight, dayStart: new Date(Math.max(midnight.getTime(), windowStart.getTime())) };
}

export function resolveDayStart(b: WindowBounds, prev: SamplePoint | null, firstToday: SamplePoint | null): DayStart | null {
  if (b.windowStart.getTime() >= b.midnight.getTime()) return { pct: 0, from: 'window_start' };
  const prevFresh = prev !== null && b.midnight.getTime() - prev.at.getTime() <= PACE_LIMITS.prevSampleMaxAgeMs;
  if (prev && prevFresh) return { pct: prev.pct, from: 'prev_sample' };
  if (firstToday) return { pct: firstToday.pct, from: 'first_sample_today' };
  if (prev) return { pct: prev.pct, from: 'prev_sample' };
  return null;
}

export interface PaceInput {
  now: Date;
  /** Haftalik oyna ko'rinishi (3.1/1.5); `null` yoki `resetsAt=null` bo'lsa pace yo'q. */
  view: LimitWindowView | null;
  dayStart: DayStart | null;
  settings: PaceSettings;
  /** "Bugun uchun ruxsat" bugun berilgan. */
  overriddenToday: boolean;
  alertsToday: { soft: Date | null; hard: Date | null };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computePace(input: PaceInput): WeeklyPace | null {
  const { view, now, dayStart: ds, settings } = input;
  if (!view || !view.resetsAt || !ds) return null;
  const resetsAt = new Date(view.resetsAt);
  if (!Number.isFinite(resetsAt.getTime()) || resetsAt.getTime() <= now.getTime()) return null;
  const b = windowBounds(now, resetsAt);

  const current = Math.max(0, view.usedPct);
  const dayStartPct = Math.min(Math.max(0, ds.pct), Math.max(0, current));
  const remainingDays = Math.max((resetsAt.getTime() - b.dayStart.getTime()) / DAY_MS, PACE_LIMITS.minRemainingDays);
  const base = Math.max(0, 100 - dayStartPct);
  const allowance = Math.min(base, base / remainingDays);
  const usedToday = Math.max(0, current - dayStartPct);
  const pctOfAllowance = allowance > 0 ? Math.min(1000, round1((usedToday / allowance) * 100)) : 100;
  const expectedPct = Math.min(100, Math.max(0, ((now.getTime() - b.windowStart.getTime()) / SEVEN_DAY_MS) * 100));

  const f = view.forecast ?? null;
  const exhaustAt = f && current < 100 ? f.exhaustsAt : null;
  const exhaustBeforeReset = f && current < 100 ? f.beforeReset : null;

  let status: PaceStatus = 'on_track';
  if (pctOfAllowance >= settings.hardPct) status = 'exceeded';
  else if (pctOfAllowance >= settings.softPct || (f !== null && f.beforeReset && f.confidence !== 'low' && current < 100)) status = 'fast';

  const blocked = settings.enabled && settings.enforce && !input.overriddenToday && pctOfAllowance >= settings.hardPct;
  return {
    dayStartPct: round2(dayStartPct),
    dayStartFrom: ds.from,
    allowancePct: round2(allowance),
    usedTodayPct: round2(usedToday),
    pctOfAllowance,
    expectedPct: round2(expectedPct),
    currentPct: round2(current),
    onTrack: status === 'on_track',
    status,
    exhaustAt,
    exhaustBeforeReset,
    resetsAt: resetsAt.toISOString(),
    windowStartsAt: b.windowStart.toISOString(),
    dayStartsAt: b.dayStart.toISOString(),
    remainingDays: round2(remainingDays),
    source: view.source,
    stale: view.stale,
    enabled: settings.enabled,
    softPct: settings.softPct,
    hardPct: settings.hardPct,
    enforce: settings.enforce,
    overriddenToday: input.overriddenToday,
    blocked,
    alertsToday: { soft: input.alertsToday.soft?.toISOString() ?? null, hard: input.alertsToday.hard?.toISOString() ?? null },
  };
}

/** Navbat/gate uchun: kechiktirish sababi matni (yo'q = ruxsat). */
export function paceBlockMessage(pace: WeeklyPace | null | undefined): string | null {
  if (!pace || !pace.blocked) return null;
  return paceExceededMessage({ allowancePct: pace.allowancePct, usedTodayPct: pace.usedTodayPct, estimate: pace.source === 'estimate' });
}

export type PaceAlertLevel = 'soft' | 'hard';

/**
 * Bir kunda har daraja bir marta. `hard` bo'lsa `soft` ham "yuborilgan" hisoblanadi (sakrashda ortiqcha yumshoq xabar kelmasin),
 * lekin faqat `hard` matni yuboriladi. O'chirilgan sozlama va juda kichik ulush (< `minAlertAllowancePct`) ogohlantirmaydi.
 */
export function alertToSend(pace: WeeklyPace | null, already: ReadonlySet<PaceAlertLevel>): { send: PaceAlertLevel | null; mark: PaceAlertLevel[] } {
  const none = { send: null, mark: [] as PaceAlertLevel[] };
  if (!pace || !pace.enabled || pace.allowancePct < PACE_LIMITS.minAlertAllowancePct) return none;
  const missing = (levels: PaceAlertLevel[]): PaceAlertLevel[] => levels.filter((l) => !already.has(l));
  if (pace.pctOfAllowance >= pace.hardPct) return already.has('hard') ? none : { send: 'hard', mark: missing(['soft', 'hard']) };
  if (pace.pctOfAllowance >= pace.softPct) return already.has('soft') || already.has('hard') ? none : { send: 'soft', mark: ['soft'] };
  return none;
}

/** Ikki kuzatuvning oynasi bir xilmi (`resetsAt` farqi < 1 daqiqa). */
export const sameWindow = (a: Date, b: Date): boolean => Math.abs(a.getTime() - b.getTime()) <= SAME_WINDOW_TOLERANCE_MS;

/** Keyingi Toshkent yarim kechasi (kun chegarasi o'zgarishi: klientlarga push uchun taymer). */
export function nextMidnight(now: Date): Date {
  return new Date(tashkentDayStart(tashkentDayOf(now)).getTime() + DAY_MS);
}
