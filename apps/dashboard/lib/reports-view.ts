import { GenerateReportBodySchema, ReportSettingsSchema } from "@commander/contracts";
import type { GenerateReportBody, ReportData, ReportKind, ReportSection, ReportSettings, ReportSummaryDto } from "@commander/contracts";
import { formatCost, formatDuration, formatTokens } from "./format";

/** Hisobotlar uchun sof ko'rinish yordamchilari. */

export const REPORT_KIND_LABEL: Record<ReportKind, string> = { daily: "Kunlik", weekly: "Haftalik" };

/** 0 = yakshanba (center bilan bir xil). */
export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Yakshanba" },
  { value: 1, label: "Dushanba" },
  { value: 2, label: "Seshanba" },
  { value: 3, label: "Chorshanba" },
  { value: 4, label: "Payshanba" },
  { value: 5, label: "Juma" },
  { value: 6, label: "Shanba" },
];

export const COST_LABEL = "API-ekvivalent narx";
export const COST_NOTE = "Obuna uchun haqiqiy to'lov emas";

const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];

/** `YYYY-MM-DD` -> "13 noy"; boshqa format o'zgarishsiz. */
export function formatReportDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const month = MONTHS[Number(m[1]) - 1];
  return month ? `${Number(m[2])} ${month}` : day;
}

/** Davr: bir kun bo'lsa "13 noy", aks holda "10 noy – 16 noy". */
export function formatPeriod(from: string, to: string): string {
  return from === to ? formatReportDay(from) : `${formatReportDay(from)} – ${formatReportDay(to)}`;
}

export function reportTitle(r: Pick<ReportSummaryDto, "kind" | "periodStart" | "periodEnd">): string {
  return `${REPORT_KIND_LABEL[r.kind]} hisobot · ${formatPeriod(r.periodStart, r.periodEnd)}`;
}

/** Faol vaqt: sekund -> "2 soat 5 daq". */
export function formatActiveTime(seconds: number): string {
  return seconds <= 0 ? "0 daq" : formatDuration(Math.max(60, seconds) * 1000);
}

/** 0..1 ulush -> "12%" (kichik qiymatlar uchun bitta kasr). */
export function formatShare(share: number): string {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function costText(usd: number | null): string {
  return usd === null ? "narx yo'q" : `≈ ${formatCost(usd)}`;
}

/** Reja va haqiqat: "Reja 6 s / haqiqat 4.5 s (3 vazifa)". */
export function planVsActualText(p: ReportSection["planVsActual"]): string | null {
  if (!p) return null;
  const h = (n: number) => `${Math.round(n * 10) / 10} s`;
  const diff = p.actualHours - p.plannedHours;
  const tag = p.plannedHours > 0 && diff > 0 ? ` (+${h(diff)})` : "";
  return `Reja ${h(p.plannedHours)} / haqiqat ${h(p.actualHours)}${tag} · ${p.tasks} ta vazifa`;
}

export type LimitSource = "official" | "estimate" | null;

export function limitSourceLabel(source: LimitSource): string {
  return source === "official" ? "rasmiy" : source === "estimate" ? "taxmin" : "manba noma'lum";
}

/** Limit bloki: foizlar FAQAT manba bilan (CLAUDE.md #6); manba yo'q bo'lsa foiz ko'rsatilmaydi. */
export function limitsView(l: ReportData["limits"]): { source: string; rows: { label: string; value: string }[] } | null {
  if (!l) return null;
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);
  const rows =
    l.source === null
      ? []
      : [
          { label: "5 soatlik oyna", value: pct(l.fiveHourPct) },
          { label: "7 kunlik oyna", value: pct(l.sevenDayPct) },
        ];
  return { source: limitSourceLabel(l.source), rows };
}

export interface SectionView {
  key: string;
  name: string;
  closed: { key: string; title: string | null }[];
  stats: { label: string; value: string; hint?: string }[];
  topTasks: { key: string; title: string | null; tokens: string; cost: string }[];
  plan: string | null;
  limitShare: string;
  summaries: string[];
}

/** Bo'lim (jami yoki loyiha) uchun ko'rsatish modeli. */
export function sectionView(s: ReportSection): SectionView {
  return {
    key: s.projectId ?? "total",
    name: s.name,
    closed: s.tasksClosed,
    stats: [
      { label: "Yopilgan vazifa", value: String(s.tasksClosed.length) },
      { label: "Commit", value: String(s.commits) },
      { label: "Vaznli token", value: formatTokens(s.tokens.weighted) },
      { label: COST_LABEL, value: costText(s.costUsd), hint: COST_NOTE },
      { label: "Faol vaqt", value: formatActiveTime(s.activeSeconds) },
      { label: "Sessiya", value: String(s.sessions) },
    ],
    topTasks: s.topTasks.map((t) => ({ key: t.key, title: t.title, tokens: formatTokens(t.weighted), cost: costText(t.costUsd) })),
    plan: planVsActualText(s.planVsActual),
    limitShare: formatShare(s.limitShare),
    summaries: s.summaries,
  };
}

/** Loyihalar: vaznli sarf bo'yicha kamayish tartibida. */
export function sortSections(list: ReportSection[]): ReportSection[] {
  return [...list].sort((a, b) => b.tokens.weighted - a.tokens.weighted || a.name.localeCompare(b.name));
}

/** Model aralashmasi: eng katta ulush = 100% kenglik. */
export function modelBars(models: ReportSection["models"]): { model: string; width: number; label: string; cost: string }[] {
  const sorted = [...models].sort((a, b) => b.share - a.share);
  const max = sorted[0]?.share ?? 0;
  return sorted.map((m) => ({
    model: m.model,
    width: max > 0 ? Math.max(2, (m.share / max) * 100) : 0,
    label: `${formatShare(m.share)} · ${formatTokens(m.weighted)}`,
    cost: costText(m.costUsd),
  }));
}

export function filterReports(items: ReportSummaryDto[], kind: ReportKind | "all"): ReportSummaryDto[] {
  return kind === "all" ? items : items.filter((r) => r.kind === kind);
}

export function sentLabel(sentAt: string | null): string {
  return sentAt ? "yuborilgan" : "yuborilmagan";
}

// ---- Yaratish ----

export function buildGenerateBody(kind: ReportKind, send: boolean): GenerateReportBody | null {
  const r = GenerateReportBodySchema.safeParse({ kind, send });
  return r.success ? r.data : null;
}

// ---- Sozlamalar ----

export interface ReportSettingsForm {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  dailyTime: string;
  weeklyTime: string;
  weeklyDay: string;
}

export function settingsToForm(s: ReportSettings): ReportSettingsForm {
  return { ...s, weeklyDay: String(s.weeklyDay) };
}

export type ReportSettingsErrors = Partial<Record<"dailyTime" | "weeklyTime" | "weeklyDay", string>>;

/** Sxema (ReportSettingsSchema) bilan tekshiradi; maydonlar bo'yicha xato matni. */
export function validateReportSettings(f: ReportSettingsForm): { value: ReportSettings | null; errors: ReportSettingsErrors } {
  const r = ReportSettingsSchema.safeParse({ ...f, weeklyDay: f.weeklyDay.trim() === "" ? Number.NaN : Number(f.weeklyDay) });
  if (r.success) return { value: r.data, errors: {} };
  const errors: ReportSettingsErrors = {};
  for (const i of r.error.issues) {
    const k = i.path[0];
    if (k === "dailyTime" || k === "weeklyTime") errors[k] = "Vaqt HH:MM ko'rinishida (masalan 21:00)";
    else if (k === "weeklyDay") errors.weeklyDay = "Hafta kunini tanlang";
  }
  return { value: null, errors };
}
