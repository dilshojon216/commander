import type { LimitForecast, LimitWindowView } from '@commander/contracts';
import type { WindowKind } from './limits-logic.js';

/**
 * Limit tugash vaqti bashorati (3.1). Sof funksiya.
 *
 * Tezlik = kalibrlash koeffitsienti (foiz / vaznli token, `limits-logic`) * oxirgi oraliqdagi vaznli token tezligi.
 * Oraliq: 5 soatlik oyna uchun oxirgi 30 daqiqa, haftalik uchun oxirgi 24 soat (tun/dam olish ham hisobga olinadi).
 * Bashorat HAR DOIM taxmin ("≈"); `source` asos qiymatning manbasi. Yetarli ma'lumot yo'q bo'lsa `null`:
 * koeffitsient yo'q, oraliqda sarf yo'q yoki oraliqdagi sarf < `MIN_BASIS_PCT` foiz.
 */

export const FORECAST_BASIS_MINUTES: Record<WindowKind, number> = { fiveHour: 30, sevenDay: 24 * 60 };
/** Oraliqda kamida shuncha foiz sarflangan bo'lishi kerak (shovqinli bashoratdan qochish). */
export const MIN_BASIS_PCT = 0.25;
export const FORECAST_ALERT_WITHIN_MS = 30 * 60_000;

export interface ForecastInput {
  kind: WindowKind;
  now: Date;
  view: LimitWindowView | null;
  /** `now - basisMinutes` dan beri vaznli tokenlar (barcha mashinalar). */
  basisWeightedTokens: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function forecastWindow(input: ForecastInput): LimitForecast | null {
  const { view, now, kind } = input;
  if (!view) return null;
  const coefficient = view.calibration?.coefficient ?? null;
  if (coefficient === null || coefficient <= 0) return null;
  if (!Number.isFinite(input.basisWeightedTokens) || input.basisWeightedTokens <= 0) return null;
  const basisMinutes = FORECAST_BASIS_MINUTES[kind];
  const basisPct = coefficient * input.basisWeightedTokens;
  if (basisPct < MIN_BASIS_PCT) return null;
  const ratePctPerMs = basisPct / (basisMinutes * 60_000);

  const remaining = Math.max(0, 100 - view.usedPct);
  const exhaustsMs = now.getTime() + remaining / ratePctPerMs;
  if (!Number.isFinite(exhaustsMs)) return null;
  const resetsMs = view.resetsAt ? Date.parse(view.resetsAt) : null;
  const beforeReset = resetsMs !== null && Number.isFinite(resetsMs) && exhaustsMs <= resetsMs;

  const samples = view.calibration?.samples ?? 0;
  let confidence: LimitForecast['confidence'] = samples >= 5 ? 'high' : samples >= 2 ? 'medium' : 'low';
  if (view.stale && confidence === 'high') confidence = 'medium';
  if (view.reset) confidence = 'low'; // yangi oyna: hammasi taxmin

  return {
    exhaustsAt: new Date(exhaustsMs).toISOString(),
    beforeReset,
    resetsAt: view.resetsAt,
    ratePctPerHour: round2(ratePctPerMs * 3_600_000),
    basisMinutes,
    basisWeightedTokens: Math.round(input.basisWeightedTokens),
    confidence,
    source: view.source,
  };
}

/** Navbat uchun: oyna hozir (`withinMs` ichida) tugaydimi (reset'dan oldin). */
export function exhaustsWithin(view: LimitWindowView | null | undefined, now: Date, withinMs: number): boolean {
  if (!view) return false;
  if (!view.reset && view.usedPct >= 100) return true;
  const f = view.forecast;
  if (!f || !f.beforeReset) return false;
  return Date.parse(f.exhaustsAt) - now.getTime() <= withinMs;
}

// --- Telegram ogohlantirishi ---------------------------------------------------------------

/** Kalit `fiveHour` -> ogohlantirilgan oynaning `resetsAt` (epoch ms). Bir oyna uchun bir marta. */
export type ForecastAlertState = Record<string, number>;
const SAME_WINDOW_TOLERANCE_MS = 30 * 60_000;

export interface ForecastAlert {
  view: LimitWindowView;
  forecast: LimitForecast;
}

/**
 * 5 soatlik oyna 30 daqiqa ichida tugashi bashorat qilinsa BIR marta (oyna `resetsAt` bo'yicha).
 * Past ishonchli bashorat va yangi-oyna taxmini (`reset`) trigger qilmaydi; reset vaqti bo'lishi shart.
 */
export function decideForecastAlert(
  fiveHour: LimitWindowView | null | undefined,
  state: ForecastAlertState,
  now: Date,
): { alert: ForecastAlert | null; state: ForecastAlertState } {
  const f = fiveHour?.forecast;
  if (!fiveHour || !f || fiveHour.reset || !fiveHour.resetsAt || !f.beforeReset || f.confidence === 'low') return { alert: null, state };
  if (fiveHour.usedPct >= 100) return { alert: null, state }; // oddiy 80/95% ogohlantirishlari qamraydi
  const eta = Date.parse(f.exhaustsAt) - now.getTime();
  if (eta > FORECAST_ALERT_WITHIN_MS) return { alert: null, state };
  const resetsMs = Date.parse(fiveHour.resetsAt);
  const prev = state['fiveHour'];
  if (prev !== undefined && Math.abs(prev - resetsMs) < SAME_WINDOW_TOLERANCE_MS) return { alert: null, state };
  return { alert: { view: fiveHour, forecast: f }, state: { ...state, fiveHour: resetsMs } };
}
