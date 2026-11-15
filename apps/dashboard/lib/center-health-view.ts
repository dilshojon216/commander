import type { CenterCheckDto, CenterCheckKind, CenterCheckStatus, CenterHealthResponse } from "@commander/contracts";

/** "Markaz holati" kartasi (5.5) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

export const CHECK_LABEL: Record<CenterCheckKind, string> = {
  db_disk: "DB disk",
  backup: "Zaxira",
  dashboard: "Dashboard",
  tailscale: "Tailscale serve",
  runtime: "Markaz jarayoni",
  telegram: "Telegram polling",
};

export const CHECK_STATUS_LABEL: Record<CenterCheckStatus, string> = {
  ok: "Yaxshi",
  warn: "Ogohlantirish",
  critical: "Kritik",
  unknown: "Ma'lumot yo'q",
  disabled: "O'chiq",
};

/** `pill` ranglari (globals.css tokenlari). */
export const CHECK_STATUS_PILL: Record<CenterCheckStatus, string> = {
  ok: "bg-grn-bg text-grn",
  warn: "bg-org-bg text-org",
  critical: "bg-red-bg text-red",
  unknown: "bg-gray-bg text-mu",
  disabled: "bg-gray-bg text-mu",
};

const ORDER: Record<CenterCheckStatus, number> = { critical: 0, warn: 1, unknown: 2, ok: 3, disabled: 4 };

/** Yomonlari birinchi, keyin barqaror tartib (CHECK_LABEL tartibi). */
export function sortChecks(checks: readonly CenterCheckDto[]): CenterCheckDto[] {
  const rank = (k: CenterCheckKind): number => Object.keys(CHECK_LABEL).indexOf(k);
  return [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || rank(a.kind) - rank(b.kind));
}

export interface CardSummary {
  worst: "ok" | "warn" | "critical";
  /** E'tibor talab qiladiganlar soni (warn/critical). */
  attention: number;
  openIncidents: number;
  machinesOffline: number;
}

export function summarize(h: CenterHealthResponse): CardSummary {
  return {
    worst: h.status,
    attention: h.checks.filter((c) => c.status === "warn" || c.status === "critical").length,
    openIncidents: h.incidents.filter((i) => i.resolvedAt === null).length,
    machinesOffline: h.machinesOffline,
  };
}

export function formatUptime(sec: number): string {
  if (sec < 90) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} daq`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} soat`;
  return `${Math.round(h / 24)} kun`;
}
