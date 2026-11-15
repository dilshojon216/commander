import type { ProjectScanSummary, ScanCounts, ScanFinding, ScanSeverity } from '@commander/contracts';
import { SEVERITY_RANK } from '@commander/contracts';
import { TASHKENT_OFFSET_MS, addDays, tashkentDayOf, tashkentDayStart } from '../projects/tashkent-day.js';

/** Haftalik reja: yakshanba 06:00 (Asia/Tashkent, UTC+5, DST yo'q). */
export const SCAN_WEEKDAY = 0; // yakshanba (JS getUTCDay)
export const SCAN_HOUR = 6;
const HOUR_MS = 3_600_000;

/** Toshkent kalendar kunining hafta kuni (0 = yakshanba). */
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** `day` (YYYY-MM-DD, Toshkent) dan boshlab orqaga eng yaqin yakshanba (kunning o'zi ham). */
function sundayOnOrBefore(day: string): string {
  return addDays(day, -weekdayOf(day));
}

/** Rejalashtirilgan skan instanti (yakshanba 06:00 Toshkent) berilgan yakshanba kuni uchun. */
const dueInstant = (sunday: string): Date => new Date(tashkentDayStart(sunday).getTime() + SCAN_HOUR * HOUR_MS);

/**
 * `now` dan oldin yoki teng bo'lgan oxirgi rejalashtirilgan skan: `key` = o'sha yakshanba (`YYYY-MM-DD`), `at` = 06:00 instanti.
 * Yakshanba 05:59 da oldingi haftaniki, 06:00 da yangisi.
 */
export function lastDue(now: Date): { key: string; at: Date } {
  const day = tashkentDayOf(now);
  let sunday = sundayOnOrBefore(day);
  if (now.getTime() < dueInstant(sunday).getTime()) sunday = addDays(sunday, -7);
  return { key: sunday, at: dueInstant(sunday) };
}

/** Keyingi rejalashtirilgan skan instanti (`now` dan qat'iy keyin). */
export function nextDue(now: Date): Date {
  const last = lastDue(now);
  return dueInstant(addDays(last.key, 7));
}

/** Reja state'i: `dueKey` oxirgi ishga tushirilgan (yoki bosib o'tilgan) yakshanba. */
export interface ScheduleState {
  dueKey: string | null;
  /** Haftalik skan boshlangan instant (ISO); dayjest yuborilmaguncha turadi. */
  runStartedAt: string | null;
  digestPending: boolean;
}

export const EMPTY_SCHEDULE: ScheduleState = { dueKey: null, runStartedAt: null, digestPending: false };

export type ScheduleAction =
  /** Birinchi marta ko'rildi: darhol skan QILINMAYDI (deploy tasodifiy vaqtda), keyingi yakshanbani kutadi. */
  | { kind: 'init'; dueKey: string }
  | { kind: 'run'; dueKey: string }
  /** Skan tugagan, dayjest yuborilmagan (markaz qayta ishga tushgan): eskirgach yuborish. */
  | { kind: 'digest' }
  | { kind: 'idle' };

/** Dayjest uchun kutish: skan boshlanganidan keyin shuncha o'tgach (markaz o'chib-yonsa) yuboriladi. */
export const DIGEST_GRACE_MS = 45 * 60_000;

export function decideSchedule(i: { now: Date; enabled: boolean; digest: boolean; state: ScheduleState; running: boolean }): ScheduleAction {
  if (i.running) return { kind: 'idle' };
  const last = lastDue(i.now);
  if (i.state.dueKey === null) return { kind: 'init', dueKey: last.key };
  if (i.enabled && i.state.dueKey < last.key) return { kind: 'run', dueKey: last.key };
  if (i.state.digestPending && i.state.runStartedAt && i.now.getTime() - Date.parse(i.state.runStartedAt) >= DIGEST_GRACE_MS) return { kind: 'digest' };
  return { kind: 'idle' };
}

export function parseSchedule(v: unknown): ScheduleState {
  if (typeof v !== 'object' || v === null) return { ...EMPTY_SCHEDULE };
  const o = v as Record<string, unknown>;
  return {
    dueKey: typeof o['dueKey'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o['dueKey']) ? o['dueKey'] : null,
    runStartedAt: typeof o['runStartedAt'] === 'string' ? o['runStartedAt'] : null,
    digestPending: o['digestPending'] === true,
  };
}

// --- dayjest ----------------------------------------------------------------------------------------

export interface DigestRow {
  projectName: string;
  machineName: string;
  counts: ScanCounts;
  secretCount: number;
  vulnCount: number;
  outdatedCount: number;
  partial: boolean;
  top: ScanFinding[];
}

export interface DigestTotals {
  projects: number;
  critical: number;
  high: number;
  secrets: number;
  outdated: number;
  partial: number;
}

export function digestTotals(rows: readonly DigestRow[]): DigestTotals {
  const t: DigestTotals = { projects: rows.length, critical: 0, high: 0, secrets: 0, outdated: 0, partial: 0 };
  for (const r of rows) {
    t.critical += r.counts.critical;
    t.high += r.counts.high;
    t.secrets += r.secretCount;
    t.outdated += r.outdatedCount;
    if (r.partial) t.partial++;
  }
  return t;
}

/** Dayjestda faqat critical/high (va sirlar) bor loyihalar, jiddiyligi bo'yicha. */
export function digestAttention(rows: readonly DigestRow[]): DigestRow[] {
  return rows
    .filter((r) => r.counts.critical > 0 || r.counts.high > 0 || r.secretCount > 0)
    .sort((a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || b.secretCount - a.secretCount || a.projectName.localeCompare(b.projectName));
}

/** Dayjest uchun faqat critical/high va sirlar topilmalari (eng jiddiylari birinchi). */
export function digestTopFindings(findings: readonly ScanFinding[], limit = 3): ScanFinding[] {
  const sev = (s: ScanSeverity): boolean => SEVERITY_RANK[s] <= SEVERITY_RANK.high;
  return findings.filter((f) => f.kind !== 'outdated' && sev(f.severity)).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, limit);
}

/** Loyiha satrlarini guruhlash: bir repo bir nechta mashinada bo'lsa, eng yangi skan qoladi (kalit `projectKey`). */
export function latestPerKey(items: readonly ProjectScanSummary[]): ProjectScanSummary[] {
  const best = new Map<string, ProjectScanSummary>();
  for (const it of items) {
    const cur = best.get(it.projectKey);
    if (!cur || it.scannedAt > cur.scannedAt) best.set(it.projectKey, it);
  }
  return [...best.values()];
}

/** Telegram'ga Toshkent vaqti bilan sana. */
export const tashkentDate = (d: Date): string => new Date(d.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
