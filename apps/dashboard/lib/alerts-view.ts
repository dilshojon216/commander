import type { AlertDto, AlertKind, WatchdogOverride, WatchdogSettings, WatchdogThresholds } from "@commander/contracts";
import { WatchdogSettingsSchema, WatchdogThresholdsSchema } from "@commander/contracts";
import { formatCompact, formatTokens } from "./format";

/** Ogohlantirishlar (watchdog) uchun sof ko'rinish yordamchilari. */

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  waiting: "Kutmoqda",
  burn: "Ortiqcha sarf",
  error_loop: "Xato takrori",
};

/** Qisqa belgi-ikonka. */
export const ALERT_KIND_ICON: Record<AlertKind, string> = {
  waiting: "◔",
  burn: "▲",
  error_loop: "↻",
};

export const AUTO_STOP_WARNING = "Avtomatik to'xtatish remote amal: audit qilinadi";

export function alertKindLabel(kind: AlertKind): string {
  return ALERT_KIND_LABEL[kind];
}

/** Ochiq ogohlantirishlar ro'yxatiga push'ni qo'llaydi: `open` bo'lmasa ro'yxatdan chiqadi. Yangisi tepada. */
export function applyAlertPush(list: AlertDto[], alert: AlertDto): AlertDto[] {
  const rest = list.filter((a) => a.id !== alert.id);
  if (alert.state !== "open") return rest;
  const i = list.findIndex((a) => a.id === alert.id);
  if (i === -1) return sortAlerts([alert, ...rest]);
  const next = list.slice();
  next[i] = alert;
  return sortAlerts(next);
}

/** "Yopish" bosilgach: serverdan javob kelguncha ro'yxatdan olib tashlash. */
export function dismissAlertLocal(list: AlertDto[], id: string): AlertDto[] {
  return list.filter((a) => a.id !== id);
}

/** Eng yangi (createdAt) birinchi; teng bo'lsa id bo'yicha barqaror. */
export function sortAlerts(list: AlertDto[]): AlertDto[] {
  return [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

function num(m: AlertDto["metrics"], k: string): number | null {
  const v = m[k];
  return typeof v === "number" ? v : null;
}

/** Qisqa raqamli xulosa (faqat metrikalardan; matn saqlanmaydi). */
export function alertSummary(a: AlertDto): string {
  switch (a.kind) {
    case "waiting": {
      const min = num(a.metrics, "minutes");
      return min === null ? "Javob kutmoqda" : `${formatCompact(min * 60_000)} dan beri javob kutmoqda`;
    }
    case "burn": {
      const w = num(a.metrics, "weighted10m");
      const pct = num(a.metrics, "pct10m");
      const bits = [w !== null && `${formatTokens(w)} vaznli token / 10 daq`, pct !== null && `limitning ${Math.round(pct * 10) / 10}%`].filter(Boolean);
      return bits.length ? bits.join(" · ") : "Sarf tezligi yuqori";
    }
    case "error_loop": {
      const c = num(a.metrics, "count");
      return c === null ? "Bir xil xato takrorlanmoqda" : `Bir xil xato ${c} marta takrorlandi`;
    }
  }
}

export function alertTarget(a: AlertDto): string {
  return a.projectName ?? a.sessionName ?? "Sessiya";
}

export function alertHref(a: AlertDto): string {
  return `/sessions/${a.sessionId}`;
}

export function remindersText(n: number): string | null {
  return n > 0 ? `${n} ta eslatma yuborildi` : null;
}

export function alertStateLabel(a: AlertDto): string {
  if (a.state === "open") return "ochiq";
  return a.state === "dismissed" ? "yopilgan" : "hal bo'lgan";
}

// ---- Sozlamalar formasi ----

export type ThresholdField = "waitingMinutes" | "burnWeightedTokens" | "burnWindowPct" | "errorLoopCount";

export interface ThresholdFieldMeta {
  key: ThresholdField;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export const THRESHOLD_FIELDS: ThresholdFieldMeta[] = [
  { key: "waitingMinutes", label: "Kutish (daqiqa)", hint: "Sessiya shuncha daqiqa javob kutsa ogohlantiriladi", min: 1, max: 1440, step: 1, integer: true },
  { key: "burnWeightedTokens", label: "Sarf (vaznli token / 10 daq)", hint: "10 daqiqada shuncha vaznli token sarflansa", min: 100_000, max: 1_000_000_000, step: 100_000, integer: true },
  { key: "burnWindowPct", label: "Sarf (limit %, 10 daq)", hint: "yoki limit oynasining shuncha foizi", min: 1, max: 100, step: 1, integer: false },
  { key: "errorLoopCount", label: "Xato takrori (marta)", hint: "Bir xil xato shuncha marta takrorlansa", min: 3, max: 100, step: 1, integer: true },
];

/** Forma holati: matn maydonlari (kiritish xom holatda saqlanadi, tekshiruv alohida). */
export interface ThresholdsForm {
  waitingMinutes: string;
  burnWeightedTokens: string;
  burnWindowPct: string;
  errorLoopCount: string;
  autoStop: boolean;
}

export function thresholdsToForm(t: WatchdogThresholds): ThresholdsForm {
  return {
    waitingMinutes: String(t.waitingMinutes),
    burnWeightedTokens: String(t.burnWeightedTokens),
    burnWindowPct: String(t.burnWindowPct),
    errorLoopCount: String(t.errorLoopCount),
    autoStop: t.autoStop,
  };
}

export type FieldErrors = Partial<Record<ThresholdField, string>>;

/** Maydonlarni son va chegaralar bo'yicha tekshiradi (zod sxemasi bilan bir xil qoidalar). */
export function validateThresholdsForm(f: ThresholdsForm): { value: WatchdogThresholds | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const parsed: Record<string, number> = {};
  for (const m of THRESHOLD_FIELDS) {
    const raw = f[m.key].trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) errors[m.key] = "Son kiriting";
    else if (m.integer && !Number.isInteger(n)) errors[m.key] = "Butun son bo'lishi kerak";
    else if (n < m.min || n > m.max) errors[m.key] = `${m.min.toLocaleString("en-US")} dan ${m.max.toLocaleString("en-US")} gacha`;
    else parsed[m.key] = n;
  }
  if (Object.keys(errors).length > 0) return { value: null, errors };
  const r = WatchdogThresholdsSchema.safeParse({ ...parsed, autoStop: f.autoStop });
  return r.success ? { value: r.data, errors } : { value: null, errors: { waitingMinutes: "Qiymatlar noto'g'ri" } };
}

/** Loyiha qayta belgilashi: faqat to'ldirilgan maydonlar; bo'sh maydon = umumiy qiymat. */
export interface OverrideForm {
  waitingMinutes: string;
  burnWeightedTokens: string;
  burnWindowPct: string;
  errorLoopCount: string;
  /** "" = umumiy, "on" / "off". */
  autoStop: "" | "on" | "off";
}

export function overrideToForm(o: WatchdogOverride | undefined): OverrideForm {
  return {
    waitingMinutes: o?.waitingMinutes === undefined ? "" : String(o.waitingMinutes),
    burnWeightedTokens: o?.burnWeightedTokens === undefined ? "" : String(o.burnWeightedTokens),
    burnWindowPct: o?.burnWindowPct === undefined ? "" : String(o.burnWindowPct),
    errorLoopCount: o?.errorLoopCount === undefined ? "" : String(o.errorLoopCount),
    autoStop: o?.autoStop === undefined ? "" : o.autoStop ? "on" : "off",
  };
}

/** Bo'sh forma -> `null` (qayta belgilash yo'q). Noto'g'ri qiymat -> xato. */
export function overrideFromForm(f: OverrideForm): { value: WatchdogOverride | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const out: Record<string, number | boolean> = {};
  for (const m of THRESHOLD_FIELDS) {
    const raw = f[m.key].trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) errors[m.key] = "Son kiriting";
    else if (m.integer && !Number.isInteger(n)) errors[m.key] = "Butun son bo'lishi kerak";
    else if (n < m.min || n > m.max) errors[m.key] = `${m.min.toLocaleString("en-US")} dan ${m.max.toLocaleString("en-US")} gacha`;
    else out[m.key] = n;
  }
  if (f.autoStop !== "") out.autoStop = f.autoStop === "on";
  if (Object.keys(errors).length > 0) return { value: null, errors };
  return { value: Object.keys(out).length > 0 ? (out as WatchdogOverride) : null, errors };
}

/** Yig'ilgan sozlamani PUT dan oldin sxema bilan tekshiradi. */
export function validateSettings(s: WatchdogSettings): { value: WatchdogSettings | null; error: string | null } {
  const r = WatchdogSettingsSchema.safeParse(s);
  return r.success ? { value: r.data, error: null } : { value: null, error: "Sozlamalar noto'g'ri: qiymatlar chegaradan tashqarida" };
}

/** Loyiha qayta belgilashini qo'shadi/olib tashlaydi (o'zgarmas). */
export function withProjectOverride(s: WatchdogSettings, projectId: string, o: WatchdogOverride | null): WatchdogSettings {
  const projects = { ...s.projects };
  if (o === null) delete projects[projectId];
  else projects[projectId] = o;
  return { ...s, projects };
}

export function overrideSummary(o: WatchdogOverride): string {
  const bits: string[] = [];
  if (o.waitingMinutes !== undefined) bits.push(`kutish ${o.waitingMinutes} daq`);
  if (o.burnWeightedTokens !== undefined) bits.push(`sarf ${formatTokens(o.burnWeightedTokens)}`);
  if (o.burnWindowPct !== undefined) bits.push(`limit ${o.burnWindowPct}%`);
  if (o.errorLoopCount !== undefined) bits.push(`xato ${o.errorLoopCount}x`);
  if (o.autoStop !== undefined) bits.push(o.autoStop ? "avto-to'xtatish yoqiq" : "avto-to'xtatish o'chiq");
  return bits.join(" · ");
}
