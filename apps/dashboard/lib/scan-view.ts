import { SEVERITY_RANK, buildScanFixPrompt, scanNeedsAttention } from "@commander/contracts";
import type { ProjectScanSummary, ScanCounts, ScanFinding, ScanFindingKind, ScanSeverity, ScanToolStatus, ScanTrendPoint } from "@commander/contracts";

/** Xavfsizlik tekshiruvi (6.10) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

export const SCAN_SEVERITY_ORDER: readonly ScanSeverity[] = ["critical", "high", "moderate", "low", "info"];

export const SCAN_SEVERITY_LABEL: Record<ScanSeverity, string> = { critical: "Kritik", high: "Yuqori", moderate: "O'rtacha", low: "Past", info: "Ma'lumot" };

/** `pill` ranglari (mavjud token sinflari). */
export const SCAN_SEVERITY_TONE: Record<ScanSeverity, string> = {
  critical: "bg-red text-white",
  high: "bg-red-bg text-red",
  moderate: "bg-yel-bg text-yel",
  low: "bg-blue-bg text-blue",
  info: "bg-gray-bg text-mu",
};

export const SCAN_KIND_LABEL: Record<ScanFindingKind, string> = { vulnerability: "Zaiflik", outdated: "Eskirgan", secret: "Sir", env_file: ".env fayl" };

export const SCAN_TOOL_STATUS_LABEL: Record<ScanToolStatus, string> = { ok: "Bajarildi", skipped: "O'tkazildi", failed: "Xato", timeout: "Vaqt tugadi" };
export const SCAN_TOOL_STATUS_TONE: Record<ScanToolStatus, string> = { ok: "bg-grn-bg text-grn", skipped: "bg-gray-bg text-mu", failed: "bg-red-bg text-red", timeout: "bg-yel-bg text-yel" };

/** Hisoblar yig'indisi (info hisobga olinmaydi: bu "muammo" soni emas). */
export const countsTotal = (c: ScanCounts): number => c.critical + c.high + c.moderate + c.low;

export const projectNeedsAttention = (p: Pick<ProjectScanSummary, "counts" | "secretCount">): boolean => scanNeedsAttention(p.counts, p.secretCount);

/** Ro'yxat tartibi: diqqat talab qiladiganlar (kritik, yuqori, sir) birinchi, keyin umumiy son, keyin nom. */
export function sortScanProjects(list: readonly ProjectScanSummary[]): ProjectScanSummary[] {
  const key = (p: ProjectScanSummary): number[] => [p.counts.critical, p.counts.high, p.secretCount, countsTotal(p.counts)];
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (kb[i] ?? 0) - (ka[i] ?? 0);
    return a.projectName.localeCompare(b.projectName);
  });
}

/** Trend: vaqt bo'yicha o'sish tartibida, oxirgi `max` nuqta. */
export function normalizeTrend(points: readonly ScanTrendPoint[], max = 12): ScanTrendPoint[] {
  return [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-max);
}

/** Mini-ustun balandliklari (0..100): kritik+yuqori+sirlar yig'indisi eng kattasiga nisbatan; hammasi 0 bo'lsa ham kichik "nol" chiziq. */
export function trendBars(points: readonly ScanTrendPoint[]): { pct: number; value: number; at: string }[] {
  const values = points.map((p) => p.critical + p.high + p.secrets);
  const max = Math.max(1, ...values);
  return points.map((p, i) => ({ at: p.at, value: values[i] ?? 0, pct: Math.round(((values[i] ?? 0) / max) * 100) }));
}

export interface FindingFilter {
  kind?: ScanFindingKind | "all";
  severity?: ScanSeverity | "all";
}

export function filterFindings(list: readonly ScanFinding[], f: FindingFilter): ScanFinding[] {
  return list.filter((x) => (f.kind === undefined || f.kind === "all" || x.kind === f.kind) && (f.severity === undefined || f.severity === "all" || x.severity === f.severity));
}

/** Jiddiylik tartibi bo'yicha (kritik birinchi). */
export const sortBySeverity = (list: readonly ScanFinding[]): ScanFinding[] => [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

/** Jadval qatori matni: `pkg@1.0.0 -> 1.2.3` yoki `fayl:qator (qoida)`. Sir qiymati hech qachon bo'lmaydi. */
export function findingSubject(f: ScanFinding): string {
  if (f.kind === "secret" || f.kind === "env_file") return `${f.file ?? "?"}${f.line ? `:${f.line}` : ""}${f.rule ? ` (${f.rule})` : ""}`;
  const base = `${f.package ?? "?"}${f.version ? `@${f.version}` : ""}`;
  return f.fixVersion ? `${base} → ${f.fixVersion}` : base;
}

/** Nisbiy vaqt: "3 kun oldin". */
export function scanAge(at: string, now: number): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t) || now <= 0) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "hozirgina";
  if (s < 3600) return `${Math.floor(s / 60)} daq oldin`;
  if (s < 86_400) return `${Math.floor(s / 3600)} soat oldin`;
  return `${Math.floor(s / 86_400)} kun oldin`;
}

/** Keyingi/oxirgi haftalik ishga tushirish yozuvi. */
export function scheduleLabel(nextRunAt: string | null, lastRunAt: string | null, enabled: boolean): string {
  const fmt = (iso: string): string => new Date(Date.parse(iso) + 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
  const parts: string[] = [];
  if (!enabled) parts.push("Haftalik tekshiruv o'chirilgan");
  else if (nextRunAt) parts.push(`Keyingisi: ${fmt(nextRunAt)} (Toshkent)`);
  if (lastRunAt) parts.push(`oxirgisi: ${fmt(lastRunAt)}`);
  return parts.join(" · ");
}

/** Tuzatish prompti: bir topilma yoki butun to'plam uchun (kun: Toshkent bo'yicha `YYYY-MM-DD`). */
export function fixPromptFor(projectName: string, scannedAt: string, findings: readonly ScanFinding[]): string {
  const day = new Date(Date.parse(scannedAt) + 5 * 3_600_000).toISOString().slice(0, 10);
  return buildScanFixPrompt({ projectName, day, findings });
}
