import type { UsagePoint, UsageBucket } from "@commander/contracts";

/** Asia/Tashkent = UTC+5, DST yo'q: kun chegarasi UTC 19:00. */
const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const STEP_MS: Record<UsageBucket, number> = { "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };

/** Bucket boshiga tushirish (1d: Tashkent yarim kechasi). */
export function floorToBucket(ms: number, bucket: UsageBucket): number {
  const step = STEP_MS[bucket];
  if (bucket === "1d") return Math.floor((ms + TASHKENT_OFFSET_MS) / step) * step - TASHKENT_OFFSET_MS;
  return Math.floor(ms / step) * step;
}

export function bucketStarts(fromMs: number, toMs: number, bucket: UsageBucket): number[] {
  const step = STEP_MS[bucket];
  const out: number[] = [];
  for (let t = floorToBucket(fromMs, bucket); t <= toMs && out.length < 5000; t += step) out.push(t);
  return out;
}

export interface FilledPoint {
  t: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  requests: number;
}

const total = (p: UsagePoint) => p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens;

/** Siyrak seriyani [from, to] bo'ylab 0 bilan to'ldiradi (bo'sh bucket = 0, bo'shliq emas). */
export function zeroFill(points: UsagePoint[], fromMs: number, toMs: number, bucket: UsageBucket): FilledPoint[] {
  const byT = new Map<number, UsagePoint>();
  for (const p of points) byT.set(Date.parse(p.t), p);
  return bucketStarts(fromMs, toMs, bucket).map((t) => {
    const p = byT.get(t);
    return p
      ? { t, totalTokens: total(p), inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheReadTokens: p.cacheReadTokens, cacheCreationTokens: p.cacheCreationTokens, costUsd: p.costUsd, requests: p.requests }
      : { t, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, requests: 0 };
  });
}
