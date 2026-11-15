import type { ListProjectsResponse, TokenTotals, UsageSummaryResponse } from "@commander/contracts";

/** `usage.tick` delta'larini jamlanmalarga qo'shish (aniq jami keyingi REST snapshot'da qayta olinadi). */

export interface TickDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  requests: number;
}

export function addDelta(t: TokenTotals, d: TickDelta): TokenTotals {
  return {
    inputTokens: t.inputTokens + d.inputTokens,
    outputTokens: t.outputTokens + d.outputTokens,
    cacheReadTokens: t.cacheReadTokens + d.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens + d.cacheCreationTokens,
    totalTokens: t.totalTokens + d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens,
    costUsd: d.costUsd === null ? t.costUsd : (t.costUsd ?? 0) + d.costUsd,
    requests: t.requests + d.requests,
  };
}

export function addTickToSummary(summary: UsageSummaryResponse, d: TickDelta): UsageSummaryResponse {
  const bump = (p: UsageSummaryResponse["today"]) => ({ ...p, totals: addDelta(p.totals, d) });
  return { ...summary, today: bump(summary.today), last7d: bump(summary.last7d), last30d: bump(summary.last30d), allTime: bump(summary.allTime) };
}

export function addTickToProjects(
  cur: ListProjectsResponse,
  byProject: ({ projectId: string | null } & TickDelta)[],
  nowIso: string,
): ListProjectsResponse {
  const byId = new Map(byProject.filter((b) => b.projectId).map((b) => [b.projectId as string, b]));
  return {
    ...cur,
    items: cur.items.map((p) => {
      const d = byId.get(p.id);
      return d ? { ...p, today: addDelta(p.today, d), allTime: addDelta(p.allTime, d), lastUsedAt: nowIso } : p;
    }),
  };
}
