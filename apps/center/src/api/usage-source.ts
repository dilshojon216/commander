import type { UsageBucket, UsageGroupBy } from '@commander/contracts';

/**
 * `GET /v1/usage` manba tanlovi (sof mantiq). Continuous aggregate'lar o'lchamlari:
 *  - `usage_5m`, `usage_1h`: (bucket, machine_id, model): loyiha o'lchami YO'Q;
 *  - `token_usage_daily_by_project`: (day Asia/Tashkent, project_id, model): mashina o'lchami YO'Q;
 *  - raw `token_usage`: hamma o'lcham, lekin 30 kun retention.
 * Kerakli o'lchamlar (guruhlash yoki filtr) cagg'da bo'lmasa raw ishlatiladi.
 */
export type UsageSourceName = 'usage_5m' | 'usage_1h' | 'daily_by_project' | 'raw';

export interface UsageSourcePlan {
  source: UsageSourceName;
  /** `usage_1h` dan kunlik qayta bucket'lash (Asia/Tashkent). */
  rebucketDaily: boolean;
}

export function selectUsageSource(bucket: UsageBucket, groupBy: UsageGroupBy, filters: { machine: boolean; project: boolean }): UsageSourcePlan {
  const needsProject = groupBy === 'project' || filters.project;
  const needsMachine = groupBy === 'machine' || filters.machine;
  if (bucket === '5m') return { source: needsProject ? 'raw' : 'usage_5m', rebucketDaily: false };
  if (bucket === '1h') return { source: needsProject ? 'raw' : 'usage_1h', rebucketDaily: false };
  if (needsProject && needsMachine) return { source: 'raw', rebucketDaily: false };
  if (needsMachine) return { source: 'usage_1h', rebucketDaily: true };
  return { source: 'daily_by_project', rebucketDaily: false };
}

/** Oraliq tekshiruvi: `[from, to)` va bucket uchun ruxsat etilgan eng uzun oraliq. Xato matni yoki null. */
export function validateRange(from: Date, to: Date, maxMs: number): string | null {
  if (!(from.getTime() < to.getTime())) return 'from must be earlier than to';
  if (to.getTime() - from.getTime() > maxMs) return `range is too long for this bucket (max ${Math.round(maxMs / 86_400_000)} days)`;
  return null;
}
