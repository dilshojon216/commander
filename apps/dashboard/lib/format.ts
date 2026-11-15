/** Raqam va vaqt formatlari. Vaqt ko'rsatish Asia/Tashkent (UTC+5, DST yo'q) bo'yicha: server va brauzerda bir xil. */

const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const WEEKDAYS = ["Yak", "Dush", "Sesh", "Chor", "Pay", "Jum", "Shan"];
const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];

/** Davomiylik: "5 s", "3 daq", "2 soat 5 daq", "1 kun 3 soat". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} daq`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} soat ${m % 60} daq` : `${h} soat`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} kun ${h % 24} soat` : `${d} kun`;
}

/** Dizayndagi qisqa davomiylik: "hozir", "12 daq", "1 s 20 daq", "3 s", "2 kun 14 s". */
export function formatCompact(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 45) return "hozir";
  const m = Math.floor(s / 60) || 1;
  if (m < 60) return `${m} daq`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} s ${m % 60} daq` : `${h} s`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} kun ${h % 24} s` : `${d} kun`;
}

/** Ishlash vaqti: "6 kun 4 soat", "21 kun", "3 soat 10 daq". */
export function formatUptime(ms: number): string {
  return formatDuration(ms);
}

/** "3 daq oldin", "2 kun oldin", 30 kundan keyin sana. */
export function formatRelative(unixSeconds: number, now: number = Date.now()): string {
  const diff = now - unixSeconds * 1000;
  if (diff < 45_000) return "hozirgina";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${Math.max(m, 1)} daq oldin`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} kun oldin`;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function msSince(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : now - t;
}

/** "Oxirgi ishlatilgan": hozir / 3 daq / 5 s / kecha / 3 kun. */
export function formatLastUsed(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  if (diff < 45_000) return "hozir";
  const m = Math.floor(diff / 60_000) || 1;
  if (m < 60) return `${m} daq`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} s`;
  const d = Math.floor(h / 24);
  return d === 1 ? "kecha" : `${d} kun`;
}

/** 1_234_567 -> "1.23M", 67_600_000 -> "67.6M", 1_520_000_000 -> "1.52B", 140_300 -> "140K", 391 -> "391". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number, d: number) => v.toFixed(d).replace(/\.?0+$/, "");
  if (abs >= 1e9) return `${trim(n / 1e9, 2)}B`;
  if (abs >= 1e7) return `${trim(n / 1e6, 1)}M`;
  if (abs >= 1e6) return `${trim(n / 1e6, 2)}M`;
  if (abs >= 1e5) return `${Math.round(n / 1e3)}K`;
  if (abs >= 1e3) return `${trim(n / 1e3, 1)}K`;
  return String(Math.round(n));
}

/** Nol bo'lsa "—" (jadval kataklari uchun). */
export function formatTokensOrDash(n: number): string {
  return n === 0 ? "—" : formatTokens(n);
}

/** 1092 -> "1 092" (dizayndagi probel bilan). */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** API ekvivalenti: "$24", "$1 420", "$2.10". null = narx noma'lum. */
export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd >= 10) return `$${formatCount(usd)}`;
  return `$${usd.toFixed(2)}`;
}

/** Tashkent soati "09:42". */
export function formatClock(ms: number): string {
  const d = new Date(ms + TASHKENT_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "Yak 06:00". */
export function formatWeekdayClock(ms: number): string {
  const d = new Date(ms + TASHKENT_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${formatClock(ms)}`;
}

/** "15 okt" (Tashkent kuni). */
export function formatDayLabel(ms: number): string {
  const d = new Date(ms + TASHKENT_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function formatDateTime(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return `${formatDayLabel(ms)} ${formatClock(ms)}`;
}

/** Taymer: 252000 ms -> "4:12". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
