import type { LimitCalibration, LimitWindowView } from '@commander/contracts';

/**
 * Obuna limitlari mantig'i (PLAN 6.3). Sof funksiyalar: DB va soat tashqaridan beriladi.
 *
 * Qoidalar:
 *  1. Limit akkaunt bo'yicha umumiy: oyna uchun mashinalar bo'ylab ENG YANGI rasmiy kuzatuv g'olib.
 *  2. Rasmiy kuzatuv `freshSeconds` dan eski bo'lsa `stale=true`.
 *  3. Kuzatuvdagi `resetsAt` o'tgan bo'lsa oyna YANGILANGAN: qiymat yangi oyna uchun TAXMIN (`source=estimate`,
 *     `reset=true`). Kalibrlash koeffitsienti bo'lmasa 0% (hech narsa to'qilmaydi).
 *  4. Rasmiy kuzatuv eskirgan (stale), oynasi tugamagan va undan keyin token sarflangan bo'lsa: rasmiy qiymat +
 *     koeffitsient * vaznli tokenlar (`source=estimate`). Koeffitsient bo'lmasa rasmiy qiymat (stale) o'zgarishsiz.
 *  5. Kalibrlash: bir oynadagi ketma-ket rasmiy kuzatuvlar orasida foiz oshgan va token sarflangan juftliklardan
 *     `sum(dPct) / sum(vaznli token)`. Cheklov: limit claude.ai/boshqa mijozlardagi sarfni ham hisoblaydi, biz esa
 *     faqat monitoring qilinadigan mashinalardagi tokenlarni ko'ramiz: koeffitsient shu sababli yuqoriga qiyshayishi mumkin.
 */

export type WindowKind = 'fiveHour' | 'sevenDay';

export const FRESH_SECONDS = 180;
export const FIVE_HOUR_MS = 5 * 3_600_000;
export const SEVEN_DAY_MS = 7 * 24 * 3_600_000;
export const WINDOW_MS: Record<WindowKind, number> = { fiveHour: FIVE_HOUR_MS, sevenDay: SEVEN_DAY_MS };
/** Ikki kuzatuvning `resetsAt` i shu farqdan kichik bo'lsa bir oyna deb hisoblanadi. */
export const SAME_WINDOW_TOLERANCE_MS = 60_000;
export const MAX_CALIBRATION_PAIRS = 20;

/** PLAN 6.3: cache_read kam vaznda, chiqish tokenlari yuqori vaznda. */
export const TOKEN_WEIGHTS = { input: 1, output: 5, cacheCreation: 1.25, cacheRead: 0.1 } as const;

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export const weightedTokens = (t: TokenSums): number =>
  t.input * TOKEN_WEIGHTS.input + t.output * TOKEN_WEIGHTS.output + t.cacheCreation * TOKEN_WEIGHTS.cacheCreation + t.cacheRead * TOKEN_WEIGHTS.cacheRead;

export interface OfficialObservation {
  observedAt: Date;
  usedPct: number;
  resetsAt: Date;
  machineId: string;
}

/** Tarixdagi kuzatuv va undan OLDINGI kuzatuvdan beri vaznli tokenlar (birinchisi uchun null). */
export interface CalibrationPoint {
  observedAt: Date;
  usedPct: number;
  resetsAt: Date;
  weightedSincePrev: number | null;
}

export function fitCalibration(points: readonly CalibrationPoint[]): LimitCalibration {
  const sorted = [...points].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const pairs: Array<{ dPct: number; weighted: number }> = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.weightedSincePrev === null || cur.weightedSincePrev <= 0) continue;
    if (Math.abs(cur.resetsAt.getTime() - prev.resetsAt.getTime()) > SAME_WINDOW_TOLERANCE_MS) continue; // oyna almashgan
    const dPct = cur.usedPct - prev.usedPct;
    if (dPct <= 0) continue;
    pairs.push({ dPct, weighted: cur.weightedSincePrev });
  }
  const recent = pairs.slice(-MAX_CALIBRATION_PAIRS);
  const sumPct = recent.reduce((s, p) => s + p.dPct, 0);
  const sumW = recent.reduce((s, p) => s + p.weighted, 0);
  return { coefficient: sumW > 0 && sumPct > 0 ? sumPct / sumW : null, samples: recent.length };
}

/** Haftalik oyna: `resetsAt` dan 7 kunlik qadam bilan `now` dan keyingi birinchi reset. */
export function nextWeeklyReset(anchorResetsAt: Date, now: Date): Date {
  const diff = now.getTime() - anchorResetsAt.getTime();
  const k = diff < 0 ? 0 : Math.floor(diff / SEVEN_DAY_MS) + 1;
  return new Date(anchorResetsAt.getTime() + k * SEVEN_DAY_MS);
}

/** 5 daqiqalik usage bucket'i (barcha mashinalar yig'indisi). */
export interface UsageBucket {
  /** Bucket boshi. */
  t: Date;
  weighted: number;
}

export interface RolledWindow {
  /** Hozirgi (taxminiy) oyna boshi; usage bo'lmasa null. */
  start: Date | null;
  /** Hozirgi oyna tugashi (taxminiy); usage bo'lmasa null. */
  resetsAt: Date | null;
  weighted: number;
}

/**
 * Reset'dan keyingi YANGI oynani usage'dan tiklaydi.
 *  - 5 soatlik: oyna reset'dan keyingi BIRINCHI usage bilan boshlanadi va 5 soat davom etadi; tugagach keyingi usage
 *    yangisini boshlaydi. `now` ga yetgan oyna topilmasa (so'nggi oyna allaqachon tugagan) = 0%, resetsAt noma'lum.
 *  - haftalik: boshi `nextWeeklyReset - 7d`, sarf = shundan beri hammasi.
 */
export function rollWindowAfterReset(kind: WindowKind, resetsAt: Date, buckets: readonly UsageBucket[], now: Date): RolledWindow {
  if (kind === 'sevenDay') {
    const end = nextWeeklyReset(resetsAt, now);
    const start = new Date(end.getTime() - SEVEN_DAY_MS);
    const weighted = buckets.filter((b) => b.t.getTime() >= start.getTime() && b.t.getTime() <= now.getTime()).reduce((s, b) => s + b.weighted, 0);
    return { start, resetsAt: end, weighted };
  }
  const sorted = [...buckets].filter((b) => b.t.getTime() >= resetsAt.getTime() && b.weighted > 0).sort((a, b) => a.t.getTime() - b.t.getTime());
  let start: Date | null = null;
  let end = 0;
  let weighted = 0;
  for (const b of sorted) {
    if (start === null || b.t.getTime() >= end) {
      start = b.t;
      end = b.t.getTime() + FIVE_HOUR_MS;
      weighted = 0;
    }
    weighted += b.weighted;
  }
  if (start === null || now.getTime() >= end) return { start: null, resetsAt: null, weighted: 0 };
  return { start, resetsAt: new Date(end), weighted };
}

export interface WindowInput {
  kind: WindowKind;
  now: Date;
  /** Shu oyna uchun mashinalar bo'ylab eng yangi rasmiy kuzatuv (yo'q = null). */
  latest: OfficialObservation | null;
  calibration: LimitCalibration | null;
  /** `latest.observedAt` dan keyingi vaznli tokenlar (barcha mashinalar). */
  weightedSinceObserved: number;
  /** `latest.resetsAt` dan keyingi 5 daqiqalik bucket'lar (faqat reset holati uchun; aks holda bo'sh). */
  bucketsSinceReset: readonly UsageBucket[];
  freshSeconds?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeWindowView(input: WindowInput): LimitWindowView | null {
  const { latest, now, calibration } = input;
  if (!latest) return null;
  const fresh = input.freshSeconds ?? FRESH_SECONDS;
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - latest.observedAt.getTime()) / 1000));
  const coefficient = calibration?.coefficient ?? null;
  const anchor = { usedPct: latest.usedPct, resetsAt: latest.resetsAt.toISOString(), observedAt: latest.observedAt.toISOString() };
  const base = {
    observedAt: latest.observedAt.toISOString(),
    ageSeconds,
    stale: ageSeconds > fresh,
    observedByMachineId: latest.machineId,
    anchor,
    calibration,
  };

  if (latest.resetsAt.getTime() <= now.getTime()) {
    // Rasmiy oyna tugagan: yangi oyna taxmini (CLAUDE.md #6: source=estimate).
    const rolled = rollWindowAfterReset(input.kind, latest.resetsAt, input.bucketsSinceReset, now);
    const usedPct = coefficient !== null ? round2(Math.min(1000, coefficient * rolled.weighted)) : 0;
    return { ...base, usedPct, resetsAt: rolled.resetsAt ? rolled.resetsAt.toISOString() : null, source: 'estimate', reset: true };
  }

  if (ageSeconds > fresh && coefficient !== null && input.weightedSinceObserved > 0) {
    const usedPct = round2(Math.min(1000, latest.usedPct + coefficient * input.weightedSinceObserved));
    return { ...base, usedPct, resetsAt: latest.resetsAt.toISOString(), source: 'estimate', reset: false };
  }
  return { ...base, usedPct: round2(latest.usedPct), resetsAt: latest.resetsAt.toISOString(), source: 'official', reset: false };
}

/** Eng yaqin kelajakdagi `resetsAt` (taymer uchun): hech biri yo'q bo'lsa null. */
export function nextResetInstant(views: ReadonlyArray<LimitWindowView | null>, now: Date): Date | null {
  let best: number | null = null;
  for (const v of views) {
    if (!v?.resetsAt) continue;
    const t = Date.parse(v.resetsAt);
    if (t > now.getTime() && (best === null || t < best)) best = t;
  }
  return best === null ? null : new Date(best);
}
