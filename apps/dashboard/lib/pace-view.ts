import type { PaceStatus, WeeklyPace } from "@commander/contracts";
import { formatClock, formatDayLabel } from "./format";

/**
 * Haftalik limit tezligi (6.12) uchun ko'rsatish modeli (sof). CLAUDE.md #6: taxmin ("estimate") HECH QACHON rasmiy
 * raqamdek ko'rsatilmaydi: "≈" prefiksi, kulrang ton va "taxmin, rasmiy emas" izohi.
 */

export type PaceColor = "grn" | "yel" | "red" | "mu";

export interface PaceViewModel {
  tone: "official" | "estimate";
  /** "Bugun: 9,8% ishlatildi · kunlik ulush 18% (54% sarflandi)" (taxmin bo'lsa "≈"). */
  shareText: string;
  /** Bar kengligi 0..100 (ulushning foizi). */
  barPct: number;
  overflow: boolean;
  status: PaceStatus;
  /** "rejada" | "tez ketmoqda" | "ulush tugadi". */
  statusText: string;
  statusColor: PaceColor;
  /** "Bir tekis sarflansa hozir 50% bo'lardi · haqiqatda 29,8%". */
  expectedText: string;
  /** "Shu tezlikda haftalik limit yangilanishgacha yetadi (15 noy 18:00)" / "... 14 noy 05:00 da tugaydi (yangilanish ...)" yoki null. */
  forecastText: string | null;
  forecastWarn: boolean;
  /** "taxmin, rasmiy emas" / "rasmiy kuzatuv eskirgan" yoki null. */
  sourceNote: string | null;
  /** "Bugun uchun ruxsat berilgan" / "Yangi sessiyalar kechiktirilmoqda" yoki null. */
  gateNote: string | null;
  /** Kun boshi qayerdan olingani izohi (tooltip). */
  detail: string;
}

const STATUS_TEXT: Record<PaceStatus, string> = { on_track: "rejada", fast: "tez ketmoqda", exceeded: "ulush tugadi" };
const STATUS_COLOR: Record<PaceStatus, PaceColor> = { on_track: "grn", fast: "yel", exceeded: "red" };

/** O'nli vergul, ortiqcha ",0" siz emas: "9,8", "18,0" (ulushda doim bitta xona). */
export const comma1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
const comma0or1 = (n: number): string => comma1(n).replace(/,0$/, "");

function dayTime(ms: number): string {
  return `${formatDayLabel(ms)} ${formatClock(ms)}`;
}

export function describePace(p: WeeklyPace): PaceViewModel {
  const est = p.source === "estimate";
  const a = est ? "≈" : "";
  const status = p.status;
  const resetMs = Date.parse(p.resetsAt);

  const lead = est ? "≈ shu" : "Shu";
  let forecastText: string | null = null;
  let forecastWarn = false;
  if (p.exhaustAt !== null && p.exhaustBeforeReset !== null) {
    const ex = Date.parse(p.exhaustAt);
    if (!p.exhaustBeforeReset) {
      const until = Number.isNaN(resetMs) ? "" : ` (${dayTime(resetMs)})`;
      forecastText = `${lead} tezlikda haftalik limit yangilanishgacha yetadi${until}`;
    } else if (!Number.isNaN(ex)) {
      const resets = Number.isNaN(resetMs) ? "" : ` (yangilanish ${dayTime(resetMs)})`;
      forecastText = `${lead} tezlikda haftalik limit ${dayTime(ex)} da tugaydi${resets}`;
      forecastWarn = true;
    }
  }

  const fromText = { prev_sample: "kun boshidagi rasmiy kuzatuvdan", first_sample_today: "bugungi birinchi rasmiy kuzatuvdan", window_start: "oyna bugun yangilangan (0 dan)" }[p.dayStartFrom];
  return {
    tone: est ? "estimate" : "official",
    shareText: `Bugun: ${a}${comma0or1(p.usedTodayPct)}% ishlatildi · kunlik ulush ${a}${comma0or1(p.allowancePct)}% (${Math.round(p.pctOfAllowance)}% sarflandi)`,
    barPct: Math.max(0, Math.min(100, p.pctOfAllowance)),
    overflow: p.pctOfAllowance > 100,
    status,
    statusText: STATUS_TEXT[status],
    statusColor: est && status === "on_track" ? "mu" : STATUS_COLOR[status],
    expectedText: `Bir tekis sarflansa hozir ${a}${comma0or1(p.expectedPct)}% bo'lardi · haqiqatda ${a}${comma0or1(p.currentPct)}%`,
    forecastText,
    forecastWarn,
    sourceNote: est ? "taxmin, rasmiy emas" : p.stale ? "rasmiy kuzatuv eskirgan" : null,
    gateNote: p.overriddenToday ? "Bugun uchun ruxsat berilgan" : p.blocked ? "Yangi sessiyalar kechiktirilmoqda" : null,
    detail: `Kun boshi: ${comma0or1(p.dayStartPct)}% (${fromText}); qolgan ${comma1(p.remainingDays)} kun`,
  };
}
