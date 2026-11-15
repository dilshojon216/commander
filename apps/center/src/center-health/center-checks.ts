import type { CenterCheckKind, CenterCheckStatus } from '@commander/contracts';

/**
 * Markaz o'z-o'zini kuzatishining sof qoidalari (5.5). Hech qanday I/O yo'q: o'lchovlar kiradi, `CheckResult` chiqadi.
 * `unknown` (o'lchab bo'lmadi) va `disabled` hodisa OCHMAYDI va mavjud hodisani YOPMAYDI: "tiklandi" soxta bo'lmasin.
 */

export interface CheckResult {
  kind: CenterCheckKind;
  status: CenterCheckStatus;
  summary: string;
  metrics: Record<string, number | null>;
}

export const THRESHOLDS = {
  /** DB disk: > 80% ogohlantirish, >= 90% jiddiy (gisterezis: ochiq hodisa 2 punkt pastga tushmaguncha yopilmaydi). */
  diskWarnPct: 80,
  diskCriticalPct: 90,
  diskHysteresisPct: 2,
  /** Zaxira: oxirgi muvaffaqiyatli nusxa > 26 soat = warn, > 50 soat (ikki kunlik tun o'tkazib yuborilgan) = critical. */
  backupWarnHours: 26,
  backupCriticalHours: 50,
  /** Tarmoq tekshiruvlari: ketma-ket shuncha muvaffaqiyatsizlikdan keyin hodisa (tick = 60 s). */
  probeFailTicks: 2,
  /** Event-loop kechikishi (p99, ms): ketma-ket `runtimeSustainedTicks` tick davomida oshsa. */
  lagWarnMs: 500,
  lagCriticalMs: 2_000,
  runtimeSustainedTicks: 2,
  /** Xotira: RSS (bayt) va V8 heap limitidan ulush. */
  rssWarnBytes: 1.5 * 1024 ** 3,
  rssCriticalBytes: 3 * 1024 ** 3,
  heapWarnPct: 85,
  heapCriticalPct: 95,
  /** Telegram polling: shuncha soniya muvaffaqiyatli getUpdates yo'q = qotgan (long poll 30 s, ya'ni ~4 tsikl). */
  telegramStuckSec: 120,
} as const;

const gb = (b: number): string => (b / 1024 ** 3).toFixed(1);

export type Severity = 'ok' | 'warn' | 'critical';

/** Foiz bo'yicha pog'ona + gisterezis: ochiq (`prev`) holat `hysteresis` punkt pastga tushmaguncha saqlanadi. */
export function levelWithHysteresis(value: number, warn: number, critical: number, hysteresis: number, prev: Severity): Severity {
  const base: Severity = value >= critical ? 'critical' : value > warn ? 'warn' : 'ok';
  if (base === 'ok' && prev !== 'ok' && value > warn - hysteresis) return 'warn';
  if (base === 'warn' && prev === 'critical' && value >= critical - hysteresis) return 'critical';
  return base;
}

export function checkDbDisk(i: { usedPct: number | null; freeBytes: number | null; totalBytes: number | null; dbBytes: number | null; prev: Severity }): CheckResult {
  const metrics = { usedPct: i.usedPct, freeBytes: i.freeBytes, totalBytes: i.totalBytes, dbBytes: i.dbBytes };
  if (i.usedPct === null) return { kind: 'db_disk', status: 'unknown', summary: "Disk hajmini o'lchab bo'lmadi", metrics };
  const level = levelWithHysteresis(i.usedPct, THRESHOLDS.diskWarnPct, THRESHOLDS.diskCriticalPct, THRESHOLDS.diskHysteresisPct, i.prev);
  const free = i.freeBytes === null ? '' : `, bo'sh ${gb(i.freeBytes)} GB`;
  const db = i.dbBytes === null ? '' : `, baza ${gb(i.dbBytes)} GB`;
  return { kind: 'db_disk', status: level, summary: `Docker diski ${i.usedPct.toFixed(0)}% band${free}${db}`, metrics };
}

export function checkBackup(i: { lastSuccessMs: number | null; nowMs: number; uptimeMs: number }): CheckResult {
  const warnMs = THRESHOLDS.backupWarnHours * 3_600_000;
  if (i.lastSuccessMs === null) {
    // Hech qachon qayd etilmagan: markaz yangi ishga tushgan bo'lsa kutamiz, keyin ogohlantiramiz.
    const status: CenterCheckStatus = i.uptimeMs > warnMs ? 'warn' : 'unknown';
    return { kind: 'backup', status, summary: status === 'warn' ? "Zaxira nusxasi hech qachon qayd etilmagan" : "Zaxira qaydi hali yo'q", metrics: { ageHours: null } };
  }
  const ageH = Math.max(0, (i.nowMs - i.lastSuccessMs) / 3_600_000);
  const status: CenterCheckStatus = ageH > THRESHOLDS.backupCriticalHours ? 'critical' : ageH > THRESHOLDS.backupWarnHours ? 'warn' : 'ok';
  const summary = status === 'ok' ? `Oxirgi zaxira ${ageH.toFixed(1)} soat oldin` : `Oxirgi muvaffaqiyatli zaxira ${ageH.toFixed(0)} soat oldin (chegara ${THRESHOLDS.backupWarnHours} soat)`;
  return { kind: 'backup', status, summary, metrics: { ageHours: Math.round(ageH * 10) / 10 } };
}

/** Tarmoq tekshiruvi: `failStreak` ketma-ket muvaffaqiyatsizlik soni (muvaffaqiyatda 0). */
export function checkProbe(kind: 'dashboard' | 'tailscale', i: { configured: boolean; reachable: boolean | null; failStreak: number }, label: string): CheckResult {
  if (!i.configured) return { kind, status: 'disabled', summary: `${label}: tekshiruv sozlanmagan`, metrics: { failStreak: null } };
  if (i.reachable === null) return { kind, status: 'unknown', summary: `${label}: hali tekshirilmagan`, metrics: { failStreak: 0 } };
  if (i.reachable) return { kind, status: 'ok', summary: `${label}: ishlayapti`, metrics: { failStreak: 0 } };
  const down = i.failStreak >= THRESHOLDS.probeFailTicks;
  return {
    kind,
    status: down ? 'critical' : 'ok',
    summary: down ? `${label}: javob bermayapti (${i.failStreak} daqiqadan beri)` : `${label}: bitta tekshiruv muvaffaqiyatsiz (kutilmoqda)`,
    metrics: { failStreak: i.failStreak },
  };
}

/** Ketma-ket "yomon" tick'larni sanaydi (sustained qoidasi uchun). */
export class Streak {
  private n = 0;
  push(bad: boolean): number {
    this.n = bad ? this.n + 1 : 0;
    return this.n;
  }
  get count(): number {
    return this.n;
  }
}

/** Host imzolovchi holati (5.7, H-02): markaz jarayonining bog'liqligi, shu sabab "Markaz jarayoni" tekshiruviga kiradi. */
export interface SignerProbe {
  mode: 'signer' | 'file';
  reachable: boolean | null;
  locked: boolean;
  keyPresent: boolean;
  failStreak: number;
}

/**
 * Imzolovchiga yetib bo'lmasa buyruqlar FAIL-CLOSED (yuborilmaydi): ketma-ket `probeFailTicks` dan keyin critical (bitta uzilish
 * hodisa ochmaydi). Kalit yo'q/o'qilmayapti = critical. LOCK = ataylab to'xtatish: warn. Fayl rejimida (imzolovchi sozlanmagan) ta'sir yo'q.
 */
export function signerLevel(s: SignerProbe | undefined): { level: Severity; text: string | null } {
  if (!s || s.mode !== 'signer') return { level: 'ok', text: null };
  if (s.reachable === false) {
    return s.failStreak >= THRESHOLDS.probeFailTicks
      ? { level: 'critical', text: `imzolovchiga yetib bo'lmayapti (${s.failStreak} daqiqadan beri): yangi buyruqlar yuborilmaydi` }
      : { level: 'ok', text: null };
  }
  if (s.reachable === true && !s.keyPresent) return { level: 'critical', text: "imzolovchida imzo kaliti yo'q yoki Keychain'dan o'qilmayapti: buyruqlar yuborilmaydi" };
  if (s.reachable === true && s.locked) return { level: 'warn', text: 'imzolovchi qulflangan (LOCK fayli): buyruqlar yuborilmaydi' };
  return { level: 'ok', text: null };
}

export function checkRuntime(i: { lagP99Ms: number | null; rssBytes: number; heapUsedPct: number; lagStreak: number; signer?: SignerProbe }): CheckResult {
  const metrics = {
    lagP99Ms: i.lagP99Ms === null ? null : Math.round(i.lagP99Ms),
    rssMb: Math.round(i.rssBytes / 1024 ** 2),
    heapUsedPct: Math.round(i.heapUsedPct),
    signerFailStreak: i.signer?.mode === 'signer' ? i.signer.failStreak : null,
  };
  const sig = signerLevel(i.signer);
  const lagSustained = i.lagStreak >= THRESHOLDS.runtimeSustainedTicks && i.lagP99Ms !== null;
  const lagLevel: Severity = !lagSustained ? 'ok' : i.lagP99Ms! >= THRESHOLDS.lagCriticalMs ? 'critical' : i.lagP99Ms! >= THRESHOLDS.lagWarnMs ? 'warn' : 'ok';
  const memLevel: Severity =
    i.rssBytes >= THRESHOLDS.rssCriticalBytes || i.heapUsedPct >= THRESHOLDS.heapCriticalPct
      ? 'critical'
      : i.rssBytes >= THRESHOLDS.rssWarnBytes || i.heapUsedPct >= THRESHOLDS.heapWarnPct
        ? 'warn'
        : 'ok';
  const order: Severity[] = ['ok', 'warn', 'critical'];
  const status = order[Math.max(order.indexOf(lagLevel), order.indexOf(memLevel), order.indexOf(sig.level))]!;
  const parts: string[] = [];
  if (lagLevel !== 'ok') parts.push(`event-loop kechikishi p99 ${metrics.lagP99Ms} ms`);
  if (memLevel !== 'ok') parts.push(`xotira RSS ${metrics.rssMb} MB, heap ${metrics.heapUsedPct}%`);
  if (sig.text) parts.push(sig.text);
  return { kind: 'runtime', status, summary: parts.length > 0 ? `Markaz jarayoni: ${parts.join('; ')}` : `Jarayon me'yorda (RSS ${metrics.rssMb} MB, loop p99 ${metrics.lagP99Ms ?? 0} ms)`, metrics };
}

export function checkTelegram(i: { enabled: boolean; startedAt: number | null; lastOkAt: number | null; nowMs: number }): CheckResult {
  if (!i.enabled) return { kind: 'telegram', status: 'disabled', summary: "Telegram polling o'chiq", metrics: { sinceOkSec: null } };
  const ref = i.lastOkAt ?? i.startedAt;
  if (ref === null) return { kind: 'telegram', status: 'unknown', summary: 'Telegram polling hali boshlanmagan', metrics: { sinceOkSec: null } };
  const sec = Math.max(0, Math.round((i.nowMs - ref) / 1000));
  if (sec > THRESHOLDS.telegramStuckSec) {
    return { kind: 'telegram', status: 'critical', summary: `Telegram polling ${sec} soniyadan beri javob olmayapti (qotgan yoki to'xtagan)`, metrics: { sinceOkSec: sec } };
  }
  return { kind: 'telegram', status: 'ok', summary: 'Telegram polling ishlayapti', metrics: { sinceOkSec: sec } };
}

// --- Hodisa holat mashinasi (sof) ------------------------------------------------------------

export interface Desired {
  kind: CenterCheckKind;
  severity: 'warn' | 'critical';
  summary: string;
}

export interface OpenCenterIncident {
  id: string;
  kind: CenterCheckKind;
  severity: 'warn' | 'critical';
}

export interface CenterIncidentPlan {
  open: Desired[];
  /** warn -> critical: qayta xabar. */
  escalate: Array<{ id: string; desired: Desired }>;
  /** critical -> warn: jim yangilanadi. */
  downgrade: Array<{ id: string; desired: Desired }>;
  /** Matni yangilanadi (xabarsiz). */
  refresh: Array<{ id: string; desired: Desired }>;
  /** Tiklandi: faqat shu tick'da HAQIQATAN o'lchangan (`ok`) turlar. */
  resolve: OpenCenterIncident[];
}

export function desiredFrom(results: readonly CheckResult[]): Desired[] {
  return results.filter((r) => r.status === 'warn' || r.status === 'critical').map((r) => ({ kind: r.kind, severity: r.status as 'warn' | 'critical', summary: r.summary }));
}

export function planCenterIncidents(open: readonly OpenCenterIncident[], results: readonly CheckResult[]): CenterIncidentPlan {
  const plan: CenterIncidentPlan = { open: [], escalate: [], downgrade: [], refresh: [], resolve: [] };
  const want = new Map(desiredFrom(results).map((d) => [d.kind, d]));
  const okKinds = new Set(results.filter((r) => r.status === 'ok').map((r) => r.kind));
  const cur = new Map(open.map((o) => [o.kind, o]));
  for (const [kind, d] of want) {
    const o = cur.get(kind);
    if (!o) plan.open.push(d);
    else if (o.severity === 'warn' && d.severity === 'critical') plan.escalate.push({ id: o.id, desired: d });
    else if (o.severity === 'critical' && d.severity === 'warn') plan.downgrade.push({ id: o.id, desired: d });
    else plan.refresh.push({ id: o.id, desired: d });
  }
  for (const [kind, o] of cur) if (!want.has(kind) && okKinds.has(kind)) plan.resolve.push(o);
  return plan;
}

export function worstStatus(results: readonly CheckResult[]): Severity {
  if (results.some((r) => r.status === 'critical')) return 'critical';
  if (results.some((r) => r.status === 'warn')) return 'warn';
  return 'ok';
}
