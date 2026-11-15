import type { HealthContainer, HealthIncidentDto, HealthRange, HealthSeriesPoint, HealthSnapshot, HealthStatus } from "@commander/contracts";

/** Server salomatligi (3.8) ko'rinish mantig'i: sof funksiyalar (testlanadi). */

export const HEALTH_RANGES: { key: HealthRange; label: string }[] = [
  { key: "6h", label: "6 soat" },
  { key: "24h", label: "24 soat" },
  { key: "7d", label: "7 kun" },
];

export const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "Yaxshi",
  warn: "Ogohlantirish",
  critical: "Kritik",
  offline: "Oflayn",
  unknown: "Ma'lumot yo'q",
};

/** `pill` ranglari (globals.css tokenlari). */
export const STATUS_PILL: Record<HealthStatus, string> = {
  ok: "bg-grn-bg text-grn",
  warn: "bg-org-bg text-org",
  critical: "bg-red-bg text-red",
  offline: "bg-gray-bg text-mu",
  unknown: "bg-gray-bg text-mu",
};

export type Tone = "ok" | "warn" | "critical" | "none";

/** Chiziq rangi: disk/xotira/CPU foizi bo'yicha. Chegaralar: 70/90 (disk uchun 85/95 sozlamalar bilan mos kelmaydi: faqat vizual). */
export function pctTone(pct: number | null, warnAt = 85, critAt = 95): Tone {
  if (pct === null) return "none";
  if (pct >= critAt) return "critical";
  if (pct >= warnAt) return "warn";
  return "ok";
}

export const TONE_BAR: Record<Tone, string> = { ok: "var(--grn)", warn: "var(--org)", critical: "var(--red)", none: "var(--fa)" };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatPct(p: number | null): string {
  return p === null ? "—" : `${Math.round(p * 10) / 10}%`;
}

export function memPct(s: Pick<HealthSnapshot, "memory">): number | null {
  return s.memory.totalBytes > 0 ? Math.round((s.memory.usedBytes / s.memory.totalBytes) * 1000) / 10 : null;
}

export type ContainerTone = "ok" | "warn" | "bad" | "muted";

export interface ContainerPill {
  label: string;
  tone: ContainerTone;
}

/** Konteyner holati pill'i: chiqish kodi 0 = oddiy to'xtagan (muted); kod != 0, dead = bad; unhealthy/restarting = warn. */
export function containerPill(c: Pick<HealthContainer, "state" | "status" | "health">): ContainerPill {
  if (c.health === "unhealthy") return { label: "unhealthy", tone: "warn" };
  if (c.state === "running") return { label: c.health === "starting" ? "ishga tushmoqda" : "ishlamoqda", tone: "ok" };
  if (c.state === "restarting") return { label: "qayta ishga tushmoqda", tone: "warn" };
  if (c.state === "exited") {
    const code = /^Exited \((-?\d+)\)/i.exec(c.status)?.[1];
    return code === "0" ? { label: "to'xtagan", tone: "muted" } : { label: `chiqdi (${code ?? "?"})`, tone: "bad" };
  }
  if (c.state === "dead") return { label: "dead", tone: "bad" };
  if (c.state === "paused") return { label: "pauza", tone: "muted" };
  return { label: c.state, tone: "muted" };
}

export const CONTAINER_PILL_CLASS: Record<ContainerTone, string> = {
  ok: "bg-grn-bg text-grn",
  warn: "bg-org-bg text-org",
  bad: "bg-red-bg text-red",
  muted: "bg-gray-bg text-mu",
};

/** Yomonlari birinchi: bad, warn, muted, ok; keyin nom bo'yicha. */
export function sortContainers(list: HealthContainer[]): HealthContainer[] {
  const rank = { bad: 0, warn: 1, muted: 2, ok: 3 } as const;
  return [...list].sort((a, b) => rank[containerPill(a).tone] - rank[containerPill(b).tone] || a.name.localeCompare(b.name));
}

export interface SparkPoint {
  x: number;
  y: number;
}

/**
 * Sparkline nuqtalari: x vaqtga mutanosib (bo'shliqlar ko'rinadi), y 0..100% (yuqori = 100). Qiymati `null` bo'lgan
 * nuqtalar o'tkazib yuboriladi. `[]` = chizish uchun kamida 2 nuqta kerak.
 */
export function sparkPoints(series: HealthSeriesPoint[], pick: (p: HealthSeriesPoint) => number | null, w: number, h: number, fromTs?: number, toTs?: number): SparkPoint[] {
  const pts = series.map((p) => ({ ts: p.ts, v: pick(p) })).filter((p): p is { ts: number; v: number } => p.v !== null);
  if (pts.length < 2) return [];
  const t0 = fromTs ?? (pts[0] as { ts: number }).ts;
  const t1 = toTs ?? (pts[pts.length - 1] as { ts: number }).ts;
  const span = Math.max(1, t1 - t0);
  return pts.map((p) => ({
    x: Math.round(Math.min(1, Math.max(0, (p.ts - t0) / span)) * w * 10) / 10,
    y: Math.round((h - (Math.min(100, Math.max(0, p.v)) / 100) * h) * 10) / 10,
  }));
}

export function pointsToPath(pts: SparkPoint[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

export interface HealthLive {
  status: HealthStatus;
  snapshot: HealthSnapshot;
  receivedAt: string;
}

/** `machine.health` push'ini mashina bo'yicha xaritaga qo'shadi (eski push yangisini bosmasin: receivedAt bo'yicha). */
export function applyHealthPush(m: Record<string, HealthLive>, machineId: string, next: HealthLive): Record<string, HealthLive> {
  const cur = m[machineId];
  if (cur && Date.parse(cur.receivedAt) > Date.parse(next.receivedAt)) return m;
  return { ...m, [machineId]: next };
}

/** Hodisa qatori: "Disk · /data · 2 soat oldin" uchun sarlavha. */
export function incidentTitle(i: Pick<HealthIncidentDto, "kind" | "subject">): string {
  const k = { disk: "Disk", memory: "Xotira", cpu: "CPU", container: "Konteyner", systemd: "systemd", offline: "Aloqa" }[i.kind];
  return i.subject ? `${k} · ${i.subject}` : k;
}

/** "Server holati" chizig'i uchun xulosa: eng yomon holat va nechta mashina e'tibor talab qiladi. */
export function stripSummary(items: Array<{ status: HealthStatus; name: string }>): { worst: HealthStatus; attention: string[]; total: number } {
  const rank: Record<HealthStatus, number> = { unknown: 0, ok: 1, offline: 2, warn: 3, critical: 4 };
  let worst: HealthStatus = "unknown";
  for (const i of items) if (rank[i.status] > rank[worst]) worst = i.status;
  const attention = items.filter((i) => i.status === "critical" || i.status === "warn" || i.status === "offline").sort((a, b) => rank[b.status] - rank[a.status] || a.name.localeCompare(b.name)).map((i) => i.name);
  return { worst, attention, total: items.length };
}

export interface StripMachine {
  name: string;
  status: HealthStatus;
  cpuPct?: number | null;
  memPct?: number | null;
  diskMaxPct?: number | null;
  diskMaxMount?: string | null;
  containersBad?: number;
  failedUnits?: number;
  openIncidents?: number;
}

const roundPct = (p: number): string => `${Math.round(p)}%`;

/**
 * "Nega e'tibor talab qiladi": `disk 95% (/)`, `xotira 91%`, `2 konteyner xato`, `oflayn`. Chegaralar `pctTone` bilan bir xil
 * (warn 85 / critical 95); hech biri topilmasa (markaz boshqa chegara ishlatgan) holat nomi qaytariladi.
 */
export function attentionReason(i: StripMachine): string {
  if (i.status === "offline") return "oflayn";
  const bits: string[] = [];
  if (i.diskMaxPct != null && pctTone(i.diskMaxPct) !== "ok" && pctTone(i.diskMaxPct) !== "none") bits.push(`disk ${roundPct(i.diskMaxPct)}${i.diskMaxMount ? ` (${i.diskMaxMount})` : ""}`);
  if (i.memPct != null && pctTone(i.memPct) !== "ok" && pctTone(i.memPct) !== "none") bits.push(`xotira ${roundPct(i.memPct)}`);
  if (i.cpuPct != null && pctTone(i.cpuPct) !== "ok" && pctTone(i.cpuPct) !== "none") bits.push(`CPU ${roundPct(i.cpuPct)}`);
  if ((i.containersBad ?? 0) > 0) bits.push(`${i.containersBad} konteyner xato`);
  if ((i.failedUnits ?? 0) > 0) bits.push(`${i.failedUnits} servis xato`);
  if (bits.length === 0 && (i.openIncidents ?? 0) > 0) bits.push(`${i.openIncidents} ochiq hodisa`);
  return bits.length > 0 ? bits.join(", ") : STATUS_LABEL[i.status].toLowerCase();
}

/** `stripSummary().attention` bilan bir xil tartibda: har mashina uchun sabab. */
export function stripAttentionDetails(items: StripMachine[]): Array<{ name: string; reason: string }> {
  const rank: Record<HealthStatus, number> = { unknown: 0, ok: 1, offline: 2, warn: 3, critical: 4 };
  return items
    .filter((i) => i.status === "critical" || i.status === "warn" || i.status === "offline")
    .sort((a, b) => rank[b.status] - rank[a.status] || a.name.localeCompare(b.name))
    .map((i) => ({ name: i.name, reason: attentionReason(i) }));
}

/**
 * Sog'liq xulosasidan faqat ko'rinadigan mashinalarni qoldiradi (yashirin/legacy, test va markazda ko'rinmaydigan retired/merged
 * yozuvlar sanoqni buzmasin). `visible = null` (mashinalar hali yuklanmagan) = filtrlamaydi.
 */
export function visibleHealthItems<T extends { machineId: string }>(items: readonly T[], visible: ReadonlySet<string> | null): T[] {
  return visible === null ? [...items] : items.filter((i) => visible.has(i.machineId));
}
