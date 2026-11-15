import { DEFAULT_WATCHDOG_THRESHOLDS, WATCHDOG_LIMITS } from '@commander/contracts';
import type { AlertKind, SessionStatus, WatchdogSettings, WatchdogThresholds } from '@commander/contracts';

/**
 * Watchdog qoidalarini baholash (3.2). SOF funksiyalar: DB, soat va Telegram tashqaridan beriladi (vaqt sayohati bilan testlanadi).
 *
 * Bo'ron to'siqlari:
 *  1. bir sessiya + tur uchun bitta OCHIQ ogohlantirish (DB'da ham qisman UNIQUE);
 *  2. waiting: epizod = `status_since`; epizod tugamaguncha qayta yaratilmaydi, eslatma 1 soatda bir, ko'pi bilan 3 ta;
 *  3. burn/error_loop: yopilgandan keyin `cooldownMs` (30 daq) ichida yangisi yaratilmaydi (error_loop: boshqa xesh bundan mustasno);
 *  4. burn yopilishi gisterezis bilan: ko'rsatkich chegaraning yarmidan pastga tushganda;
 *  5. rad etilgan (dismissed) epizod qayta ochilmaydi.
 */

export const WAITING_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['waiting', 'awaiting_approval']);

export interface SessionSnap {
  id: string;
  machineId: string;
  projectId: string | null;
  status: SessionStatus;
  statusSince: Date;
  endedAt: Date | null;
  /** Mashina offline: yangi ogohlantirish yaratilmaydi. */
  staleSince: Date | null;
}

export interface BurnSample {
  sessionId: string;
  /** Oxirgi 10 daqiqadagi vaznli tokenlar (`weightedTokens`). */
  weighted10m: number;
}

export interface ErrorSample {
  sessionId: string;
  hash: string;
  /** Oynadagi eng katta takror soni (agentd hisoblagichi). */
  count: number;
}

export interface OpenAlertRow {
  id: string;
  kind: AlertKind;
  sessionId: string;
  episodeKey: string;
  createdAt: Date;
  lastNotifiedAt: Date | null;
  remindersSent: number;
  metrics: Record<string, number | string | null>;
}

/** Yaqinda (sovish oynasida) yaratilgan har qanday holatdagi ogohlantirish. */
export interface HistoryRow {
  sessionId: string;
  kind: AlertKind;
  episodeKey: string;
  createdAt: Date;
}

export interface EvalInput {
  now: Date;
  settings: WatchdogSettings;
  sessions: readonly SessionSnap[];
  burn: readonly BurnSample[];
  errors: readonly ErrorSample[];
  /** 5 soatlik oyna kalibrlash koeffitsienti (foiz / vaznli token); yo'q bo'lsa foiz qoidasi o'chiq. */
  fiveHourCoefficient: number | null;
  open: readonly OpenAlertRow[];
  history: readonly HistoryRow[];
}

export type Action =
  | { type: 'create'; kind: AlertKind; session: SessionSnap; episodeKey: string; metrics: Record<string, number | string | null>; autoStop: boolean }
  | { type: 'remind'; alert: OpenAlertRow }
  | { type: 'update'; alert: OpenAlertRow; metrics: Record<string, number | string | null> }
  | { type: 'resolve'; alert: OpenAlertRow; reason: 'recovered' | 'ended' | 'disabled' };

export function resolveThresholds(settings: WatchdogSettings, projectId: string | null, sessionId: string): WatchdogThresholds {
  return {
    ...DEFAULT_WATCHDOG_THRESHOLDS,
    ...settings.defaults,
    ...(projectId ? settings.projects[projectId] : undefined),
    ...settings.sessions[sessionId],
  };
}

export const burnPct = (weighted: number, coefficient: number | null): number | null => (coefficient === null ? null : Math.round(coefficient * weighted * 100) / 100);

export const waitingEpisodeKey = (statusSince: Date): string => String(statusSince.getTime());

const minutesBetween = (a: Date, b: Date): number => Math.floor((b.getTime() - a.getTime()) / 60_000);

/** Eslatma vaqti keldimi: birinchi xabardan (yoki oldingi eslatmadan) keyin 1 soat, ko'pi bilan `maxReminders`. */
export function reminderDue(alert: Pick<OpenAlertRow, 'remindersSent' | 'lastNotifiedAt' | 'createdAt'>, now: Date): boolean {
  if (alert.remindersSent >= WATCHDOG_LIMITS.maxReminders) return false;
  const last = alert.lastNotifiedAt ?? alert.createdAt;
  return now.getTime() - last.getTime() >= WATCHDOG_LIMITS.reminderGapMs;
}

export function evaluate(input: EvalInput): Action[] {
  const { now, settings } = input;
  const actions: Action[] = [];
  const bySession = new Map(input.sessions.map((s) => [s.id, s] as const));
  const burnBy = new Map(input.burn.map((b) => [b.sessionId, b.weighted10m] as const));
  const errBy = new Map<string, ErrorSample>();
  for (const e of input.errors) {
    const cur = errBy.get(e.sessionId);
    if (!cur || e.count > cur.count) errBy.set(e.sessionId, e);
  }
  const openKey = new Set(input.open.map((o) => `${o.sessionId}|${o.kind}`));

  // 1) Ochiq ogohlantirishlar: yopish / eslatish / yangilash
  for (const alert of input.open) {
    const s = bySession.get(alert.sessionId);
    if (!settings.enabled) {
      actions.push({ type: 'resolve', alert, reason: 'disabled' });
      continue;
    }
    if (!s || s.endedAt !== null || s.status === 'ended') {
      actions.push({ type: 'resolve', alert, reason: 'ended' });
      continue;
    }
    const th = resolveThresholds(settings, s.projectId, s.id);
    if (alert.kind === 'waiting') {
      if (!WAITING_STATUSES.has(s.status) || waitingEpisodeKey(s.statusSince) !== alert.episodeKey) actions.push({ type: 'resolve', alert, reason: 'recovered' });
      else if (reminderDue(alert, now)) actions.push({ type: 'remind', alert });
    } else if (alert.kind === 'burn') {
      const w = burnBy.get(s.id) ?? 0;
      const pct = burnPct(w, input.fiveHourCoefficient);
      const calm = w < th.burnWeightedTokens / 2 && (pct === null || pct < th.burnWindowPct / 2);
      if (calm) actions.push({ type: 'resolve', alert, reason: 'recovered' });
      else {
        const peak = typeof alert.metrics['weighted10m'] === 'number' ? alert.metrics['weighted10m'] : 0;
        if (w >= peak * 1.25 && w > peak) actions.push({ type: 'update', alert, metrics: { ...alert.metrics, weighted10m: Math.round(w), pct10m: pct } });
      }
    } else {
      const e = errBy.get(s.id);
      if (!e || e.hash !== alert.episodeKey) actions.push({ type: 'resolve', alert, reason: 'recovered' });
      else {
        const peak = typeof alert.metrics['count'] === 'number' ? alert.metrics['count'] : 0;
        if (e.count >= peak * 2) actions.push({ type: 'update', alert, metrics: { ...alert.metrics, count: e.count } });
      }
    }
  }
  if (!settings.enabled) return actions;

  // 2) Yangi ogohlantirishlar
  const blocked = (s: SessionSnap, kind: AlertKind, episodeKey: string): boolean => {
    if (openKey.has(`${s.id}|${kind}`)) return true;
    return input.history.some((h) => {
      if (h.sessionId !== s.id || h.kind !== kind) return false;
      if (kind === 'waiting') return h.episodeKey === episodeKey; // epizod bir marta
      if (h.episodeKey !== episodeKey && kind === 'error_loop') return false; // boshqa xato
      return now.getTime() - h.createdAt.getTime() < WATCHDOG_LIMITS.cooldownMs;
    });
  };

  for (const s of input.sessions) {
    if (s.endedAt !== null || s.status === 'ended' || s.staleSince !== null) continue;
    const th = resolveThresholds(settings, s.projectId, s.id);

    if (WAITING_STATUSES.has(s.status)) {
      const minutes = minutesBetween(s.statusSince, now);
      const key = waitingEpisodeKey(s.statusSince);
      if (minutes >= th.waitingMinutes && !blocked(s, 'waiting', key)) {
        actions.push({ type: 'create', kind: 'waiting', session: s, episodeKey: key, metrics: { minutes, status: s.status, thresholdMinutes: th.waitingMinutes }, autoStop: false });
      }
    }

    const w = burnBy.get(s.id) ?? 0;
    const pct = burnPct(w, input.fiveHourCoefficient);
    if ((w >= th.burnWeightedTokens || (pct !== null && pct >= th.burnWindowPct)) && !blocked(s, 'burn', '')) {
      actions.push({ type: 'create', kind: 'burn', session: s, episodeKey: '', metrics: { weighted10m: Math.round(w), pct10m: pct, thresholdWeighted: th.burnWeightedTokens, thresholdPct: th.burnWindowPct }, autoStop: th.autoStop });
    }

    const e = errBy.get(s.id);
    if (e && e.count >= th.errorLoopCount && !blocked(s, 'error_loop', e.hash)) {
      actions.push({ type: 'create', kind: 'error_loop', session: s, episodeKey: e.hash, metrics: { hash: e.hash, count: e.count, threshold: th.errorLoopCount }, autoStop: th.autoStop });
    }
  }
  return actions;
}

/** Ogohlantirish matni (o'zbekcha). Faqat raqamlar: foydalanuvchi matni yo'q. */
export function describeAlert(kind: AlertKind, metrics: Record<string, number | string | null>): { title: string; detail: string } {
  if (kind === 'waiting') {
    const awaiting = metrics['status'] === 'awaiting_approval';
    return {
      title: awaiting ? 'Ruxsat kutilmoqda' : 'Sessiya javob kutmoqda',
      detail: `${String(metrics['minutes'] ?? '?')} daqiqadan beri ${awaiting ? 'ruxsat so\'rovi hal qilinmagan' : 'sizning javobingiz kutilmoqda'}`,
    };
  }
  if (kind === 'burn') {
    const pct = typeof metrics['pct10m'] === 'number' ? `, 5 soatlik oynaning ~${metrics['pct10m']}% (taxmin)` : '';
    return { title: 'G\'ayritabiiy token sarfi', detail: `Oxirgi 10 daqiqada ${fmtTokens(Number(metrics['weighted10m'] ?? 0))} vaznli token${pct}` };
  }
  return { title: 'Xato takrorlanmoqda', detail: `Bir xil xato 10 daqiqada ${String(metrics['count'] ?? '?')} marta takrorlandi (xesh ${String(metrics['hash'] ?? '').slice(0, 8)})` };
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
