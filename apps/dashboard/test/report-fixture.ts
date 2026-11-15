import type { ReportData, ReportSection } from "@commander/contracts";

export const section = (over: Partial<ReportSection> = {}): ReportSection => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  name: "demo",
  tasksClosed: [
    { key: "1.1", title: "Birinchi" },
    { key: "1.2", title: null },
  ],
  commits: 4,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, weighted: 2_500_000 },
  costUsd: 3.2,
  activeSeconds: 7500,
  sessions: 3,
  topTasks: [{ key: "1.1", title: "Birinchi", weighted: 1_000_000, costUsd: 1.1 }],
  planVsActual: { plannedHours: 6, actualHours: 4.5, tasks: 3 },
  limitShare: 0.25,
  models: [{ model: "claude-opus", requests: 10, weighted: 2_000_000, outputTokens: 5000, costUsd: 2, share: 0.8 }],
  summaries: [],
  ...over,
});

export const reportData = (over: Partial<ReportData> = {}): ReportData => ({
  kind: "daily",
  from: "2026-11-13",
  to: "2026-11-13",
  total: section({ projectId: null, name: "Jami" }),
  projects: [section()],
  recommendations: ["Opus o'rniga Sonnet ishlating"],
  limits: { fiveHourPct: 40, sevenDayPct: 12, source: "official" },
  ...over,
});
