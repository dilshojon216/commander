import { USAGE_RANGE_LIMITS_MS } from "@commander/contracts";
import type { UsageBucket, UsageGroupBy } from "@commander/contracts";

export interface RangePreset {
  label: string;
  ms: number;
}

const H = 3_600_000;
const D = 24 * H;

export const RANGE_PRESETS: Record<UsageBucket, RangePreset[]> = {
  "5m": [
    { label: "1 soat", ms: H },
    { label: "3 soat", ms: 3 * H },
    { label: "6 soat", ms: 6 * H },
    { label: "24 soat", ms: D },
    { label: "3 kun", ms: 3 * D },
  ],
  "1h": [
    { label: "24 soat", ms: D },
    { label: "3 kun", ms: 3 * D },
    { label: "7 kun", ms: 7 * D },
    { label: "31 kun", ms: 31 * D },
  ],
  "1d": [
    { label: "7 kun", ms: 7 * D },
    { label: "14 kun", ms: 14 * D },
    { label: "30 kun", ms: 30 * D },
    { label: "90 kun", ms: 90 * D },
    { label: "365 kun", ms: 365 * D },
  ],
};

export const GROUP_LABELS: Record<UsageGroupBy, string> = {
  none: "Jami",
  project: "Loyiha",
  machine: "Mashina",
  model: "Model",
};

/** Bucket almashganda oraliq chegarasidan oshmasin: eng yaqin ruxsat etilgan preset. */
export function clampRange(bucket: UsageBucket, ms: number): number {
  const max = USAGE_RANGE_LIMITS_MS[bucket].max;
  const presets = RANGE_PRESETS[bucket].filter((p) => p.ms <= max);
  if (presets.some((p) => p.ms === ms)) return ms;
  return presets.reduce((best, p) => (Math.abs(p.ms - ms) < Math.abs(best.ms - ms) ? p : best), presets[0]).ms;
}

export function buildUsageQuery(bucket: UsageBucket, groupBy: UsageGroupBy, rangeMs: number, now: number): string {
  const qs = new URLSearchParams({
    bucket,
    groupBy,
    from: new Date(now - rangeMs).toISOString(),
    to: new Date(now).toISOString(),
  });
  return qs.toString();
}
