import type { TokenTotals, UsageResponse } from "@commander/contracts";
import { bucketStarts, zeroFill } from "./usage-fill";

export type TokenType = "input" | "output" | "cacheRead" | "cacheWrite";
export type TokenTypes = Record<TokenType, boolean>;

export const ALL_TOKEN_TYPES: TokenTypes = { input: true, output: true, cacheRead: true, cacheWrite: true };

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS rang (var(--cN)). */
  color: string;
  /** `times` bilan bir xil uzunlik (tanlangan token turlari yig'indisi). */
  values: number[];
  total: number;
  /** Jadval uchun: seriyaning to'liq token jami (tur bo'yicha). */
  totals: TokenTotals;
}

export interface ChartData {
  times: number[];
  series: ChartSeries[];
}

/** Dizayn: 4 ta asosiy seriya (c1..c4) + "Boshqalar" (c5). Default (7) faqat eski chaqiruvlar uchun. */
export const DESIGN_MAX_SERIES = 4;
const DEFAULT_MAX_SERIES = 7;
const OTHER_COLOR = "var(--c5)";

const EMPTY: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: b.costUsd === null ? a.costUsd : (a.costUsd ?? 0) + b.costUsd,
    requests: a.requests + b.requests,
  };
}

/** Tanlangan turlar bo'yicha jami (jadval "jami" ustuni va chart bilan mos). */
export function selectedTotal(t: TokenTotals, types: TokenTypes): number {
  return (types.input ? t.inputTokens : 0) + (types.output ? t.outputTokens : 0) + (types.cacheRead ? t.cacheReadTokens : 0) + (types.cacheWrite ? t.cacheCreationTokens : 0);
}

/** Javobdan zero-fill qilingan, `maxSeries` dan ortig'i "Boshqalar"ga yig'ilgan stacked ma'lumot. */
export function buildChartData(resp: UsageResponse, types: TokenTypes = ALL_TOKEN_TYPES, maxSeries: number = DEFAULT_MAX_SERIES): ChartData {
  const fromMs = Date.parse(resp.from);
  const toMs = Date.parse(resp.to);
  const times = bucketStarts(fromMs, toMs, resp.bucket);
  const filled = resp.series.map((s, i) => ({
    key: s.key ?? `s${i}`,
    label: s.label || (s.key ?? "Jami"),
    totals: s.total,
    values: zeroFill(s.points, fromMs, toMs, resp.bucket).map(
      (p) => (types.input ? p.inputTokens : 0) + (types.output ? p.outputTokens : 0) + (types.cacheRead ? p.cacheReadTokens : 0) + (types.cacheWrite ? p.cacheCreationTokens : 0),
    ),
  }));
  const withTotal = filled
    .map((f) => ({ ...f, total: f.values.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || b.totals.totalTokens - a.totals.totalTokens);

  const head = withTotal.slice(0, maxSeries);
  const tail = withTotal.slice(maxSeries);
  const series: ChartSeries[] = head.map((s, i) => ({ ...s, color: `var(--c${i + 1})` }));
  if (tail.length > 0) {
    const values = times.map((_, idx) => tail.reduce((acc, s) => acc + (s.values[idx] ?? 0), 0));
    series.push({
      key: "__other",
      label: `Boshqalar (${tail.length})`,
      color: OTHER_COLOR,
      values,
      total: values.reduce((a, b) => a + b, 0),
      totals: tail.reduce((acc, s) => addTotals(acc, s.totals), EMPTY),
    });
  }
  return { times, series };
}

/** Yagona (guruhsiz) kunlik qiymatlar: ProjectDetail 30 kunlik ustunlar uchun. */
export function dailyValues(resp: UsageResponse): { times: number[]; values: number[] } {
  const d = buildChartData(resp, ALL_TOKEN_TYPES, DESIGN_MAX_SERIES);
  const values = d.times.map((_, i) => d.series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  return { times: d.times, values };
}
