import type { LimitWindowView } from "@commander/contracts";
import { formatClock, formatCompact, formatDuration, formatWeekdayClock } from "./format";

/**
 * Limit oynasi uchun ko'rsatish modeli (sof). CLAUDE.md #6: taxmin HECH QACHON rasmiy raqamdek
 * ko'rsatilmaydi: "≈" prefiksi, kulrang rang va aniq izoh bilan.
 */

export type LimitTone = "official" | "estimate" | "stale" | "reset" | "none";

export interface LimitViewModel {
  tone: LimitTone;
  /** "42%" yoki "≈42%". */
  pctText: string;
  approx: boolean;
  /** Bar kengligi 0..100. */
  barPct: number;
  /** Bar to'lib ketgan (>100%). */
  overflow: boolean;
  badge: string | null;
  /** Oyna qachon yangilanadi. */
  resetText: string;
  /** Oxirgi rasmiy kuzatuv yoshi. */
  observedText: string;
  note: string | null;
}

const EMPTY: LimitViewModel = {
  tone: "none",
  pctText: "-",
  approx: false,
  barPct: 0,
  overflow: false,
  badge: null,
  resetText: "-",
  observedText: "rasmiy kuzatuv hali yo'q",
  note: "Bu oyna uchun hech qachon kuzatuv bo'lmagan.",
};

function pctNumber(v: number): string {
  return `${Math.round(v * 10) / 10}`.replace(/\.0$/, "");
}

export function describeLimitWindow(w: LimitWindowView | null, now: number): LimitViewModel {
  if (!w) return EMPTY;

  const approx = w.source === "estimate";
  const pctText = `${approx ? "≈" : ""}${pctNumber(w.usedPct)}%`;
  const barPct = Math.max(0, Math.min(100, w.usedPct));
  const overflow = w.usedPct > 100;

  const resetsAtMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  let resetText: string;
  if (Number.isNaN(resetsAtMs)) resetText = "noma'lum";
  else if (resetsAtMs <= now) resetText = "hozir yangilanmoqda";
  else resetText = `${approx && w.reset ? "taxminan " : ""}${formatDuration(resetsAtMs - now)} dan keyin`;

  const observedMs = w.observedAt ? Date.parse(w.observedAt) : NaN;
  const observedText = Number.isNaN(observedMs)
    ? "rasmiy kuzatuv yo'q"
    : `rasmiy kuzatuv ${formatDuration(now - observedMs)} oldin`;

  let tone: LimitTone;
  let badge: string | null;
  let note: string | null;
  if (w.reset) {
    tone = "reset";
    badge = "oyna yangilandi";
    note = "Oyna yangilangan: qiymat yangi oyna uchun TAXMIN, rasmiy raqam emas.";
  } else if (approx) {
    tone = "estimate";
    badge = "taxmin";
    const base = w.anchor ? ` Asos: rasmiy ${pctNumber(w.anchor.usedPct)}% (${observedText.replace("rasmiy kuzatuv ", "")}).` : "";
    note = `Taxmin: eskirgan rasmiy qiymatdan keyingi tokenlar asosida hisoblangan.${base}`;
  } else if (w.stale) {
    tone = "stale";
    badge = "eskirgan";
    note = "Rasmiy kuzatuv eskirgan: haqiqiy qiymat hozir boshqacha bo'lishi mumkin.";
  } else {
    tone = "official";
    badge = null;
    note = null;
  }

  return { tone, pctText, approx, barPct, overflow, badge, resetText, observedText, note };
}

// --- Dizayn kartasi uchun ko'rsatish modeli ------------------------------------------------------

export type LimitBarKind = "solid" | "hatch";
export type LimitColor = "tx" | "mu" | "blue" | "yel" | "red";

export interface LimitDisplay {
  tone: LimitTone;
  /** "rasmiy" / "taxmin" yorlig'i (null: kuzatuv yo'q). */
  tag: { text: string; dashed: boolean } | null;
  /** "42%" yoki "≈12%". */
  valueText: string;
  /** "· yangilandi" (faqat reset). */
  extra: string | null;
  valueColor: LimitColor;
  barKind: LimitBarKind;
  barColor: LimitColor;
  /** Bar kengligi: 0..100 (taxmin/reset'da ko'rinishi uchun kamida 2). */
  barPct: number;
  /** 80% va 95% chegara belgilari (faqat rasmiy). */
  thresholds: boolean;
  /** Karta xiraligi (eskirgan). */
  dim: boolean;
  /** "15:40 da yangilanadi · 4 s 12 daq". */
  resetLine: string;
  /** "2 daqiqa oldin kuzatilgan" / "Token hisobidan taxmin". */
  observedLine: string;
  /** Tooltip: to'liq izoh (taxmin asosi va h.k.). */
  note: string | null;
}

/** Chegaralar: 80% dan oshsa sariq, 95% dan oshsa qizil. */
export function thresholdColor(pct: number): LimitColor {
  if (pct >= 95) return "red";
  if (pct >= 80) return "yel";
  return "blue";
}

export function ageText(ms: number): string {
  if (ms < 45_000) return "hozirgina";
  const m = Math.floor(ms / 60_000) || 1;
  if (m < 60) return `${m} daqiqa oldin`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} soat oldin`;
  return `${Math.floor(h / 24)} kun oldin`;
}

function resetLineOf(w: LimitWindowView, now: number): string {
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (Number.isNaN(at)) return "Yangilanish vaqti noma'lum";
  if (at <= now) return "Hozir yangilanmoqda";
  const left = at - now;
  const when = left < 24 * 3_600_000 ? formatClock(at) : formatWeekdayClock(at);
  return `${when} da yangilanadi · ${formatCompact(left)}`;
}

export function describeLimitDisplay(w: LimitWindowView | null, now: number): LimitDisplay {
  const vm = describeLimitWindow(w, now);
  if (!w) {
    return {
      tone: "none",
      tag: null,
      valueText: "—",
      extra: null,
      valueColor: "mu",
      barKind: "solid",
      barColor: "mu",
      barPct: 0,
      thresholds: false,
      dim: false,
      resetLine: "Yangilanish vaqti noma'lum",
      observedLine: "Rasmiy kuzatuv hali yo'q",
      note: vm.note,
    };
  }
  const resetLine = resetLineOf(w, now);
  const observedMs = w.observedAt ? Date.parse(w.observedAt) : NaN;
  const observedAge = Number.isNaN(observedMs) ? null : ageText(Math.max(0, now - observedMs));

  if (vm.tone === "reset") {
    return {
      tone: "reset",
      tag: { text: "taxmin", dashed: true },
      valueText: vm.pctText,
      extra: "· yangilandi",
      valueColor: "mu",
      barKind: "hatch",
      barColor: "mu",
      barPct: Math.max(2, vm.barPct),
      thresholds: false,
      dim: false,
      resetLine,
      observedLine: "Token hisobidan taxmin · oyna qayta boshlandi",
      note: vm.note,
    };
  }
  if (vm.tone === "estimate") {
    return {
      tone: "estimate",
      tag: { text: "taxmin", dashed: true },
      valueText: vm.pctText,
      extra: null,
      valueColor: "mu",
      barKind: "hatch",
      barColor: "mu",
      barPct: Math.max(2, vm.barPct),
      thresholds: false,
      dim: false,
      resetLine,
      observedLine: "Token hisobidan taxmin",
      note: vm.note,
    };
  }
  if (vm.tone === "stale") {
    return {
      tone: "stale",
      tag: { text: "rasmiy", dashed: false },
      valueText: vm.pctText,
      extra: null,
      valueColor: "mu",
      barKind: "solid",
      barColor: "mu",
      barPct: vm.barPct,
      thresholds: false,
      dim: true,
      resetLine,
      observedLine: `${observedAge ?? "Kuzatuv vaqti noma'lum"} kuzatilgan · eskirgan`,
      note: vm.note,
    };
  }
  const color = thresholdColor(w.usedPct);
  return {
    tone: "official",
    tag: { text: "rasmiy", dashed: false },
    valueText: vm.pctText,
    extra: null,
    valueColor: color === "blue" ? "tx" : color,
    barKind: "solid",
    barColor: color,
    barPct: vm.barPct,
    thresholds: true,
    dim: false,
    resetLine,
    observedLine: observedAge ? `${observedAge} kuzatilgan` : "Kuzatuv vaqti noma'lum",
    note: null,
  };
}

/** LimitColor -> CSS o'zgaruvchi (chiziq/matn rangi). */
export const LIMIT_COLOR_VAR: Record<LimitColor, string> = {
  tx: "var(--tx)",
  mu: "var(--mu)",
  blue: "var(--blue)",
  yel: "var(--yel)",
  red: "var(--red)",
};

/**
 * Oyna uchun ko'rsatiladigan ma'lumot YO'Q: oyna umuman kuzatilmagan, yoki faqat taxmin bor va u 0% (rasmiy asos juda eski/yo'q).
 * Tarif 5 soatlik oynasiz bo'lsa, eski kuzatuvdan keyingi "≈0% · yangilandi" soxta taxmin bo'lib qoladi: uni ko'rsatmaymiz.
 * `windowMs` — oyna davomiyligi; rasmiy kuzatuv `2 * windowMs` dan eski bo'lsa asos hisoblanmaydi. `now = 0` (SSR): faqat kuzatuvsiz holat.
 */
export function hasNoWindowData(w: LimitWindowView | null, windowMs: number, now: number): boolean {
  if (w === null) return true;
  if (w.source !== "estimate" || w.usedPct > 0) return false;
  if (w.observedAt === null && w.anchor === null) return true;
  const obs = Date.parse(w.observedAt ?? w.anchor?.observedAt ?? "");
  return now > 0 && (Number.isNaN(obs) || now - obs > 2 * windowMs);
}

export const FIVE_HOUR_MS = 5 * 3_600_000;
