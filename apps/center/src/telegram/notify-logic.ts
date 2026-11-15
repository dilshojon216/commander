import type { LimitsResponse, LimitWindowView, SessionStatus } from '@commander/contracts';

// --- limit ogohlantirishlari (PLAN 6.3) -------------------------------------------------------

export type LimitWindowName = 'fiveHour' | 'sevenDay';

/** 5 soatlik oyna: 80% va 95%; haftalik: 90%. */
export const LIMIT_THRESHOLDS: Record<LimitWindowName, readonly number[]> = { fiveHour: [80, 95], sevenDay: [90] };

/** `resetsAt` kuzatuvlar orasida soniyalarga siljishi mumkin: shu farqdan kichik bo'lsa bu BIR OYNA. */
export const SAME_WINDOW_TOLERANCE_MS = 30 * 60_000;

/** Kalit `fiveHour:80` -> oxirgi ogohlantirilgan oynaning `resetsAt` (epoch ms). Sozlamalarda saqlanadi (restartdan omon qoladi). */
export type LimitAlertState = Record<string, number>;

export interface LimitAlert {
  window: LimitWindowName;
  threshold: number;
  view: LimitWindowView;
}

/**
 * Har oyna uchun har chegara BIR MARTA (oyna `resetsAt` bo'yicha aniqlanadi). Faqat RASMIY manba ogohlantiradi
 * (taxmin hech qachon trigger qilmaydi, CLAUDE.md #6). Bir vaqtda bir nechta chegara kesilsa faqat eng yuqorisi
 * yuboriladi, qolganlari ham "ogohlantirilgan" deb belgilanadi.
 */
export function decideLimitAlerts(limits: LimitsResponse, state: LimitAlertState): { alerts: LimitAlert[]; state: LimitAlertState } {
  const next: LimitAlertState = { ...state };
  const alerts: LimitAlert[] = [];
  for (const window of ['fiveHour', 'sevenDay'] as const) {
    const view = limits[window];
    if (!view || view.source !== 'official' || view.resetsAt === null) continue;
    const resetsMs = Date.parse(view.resetsAt);
    if (!Number.isFinite(resetsMs)) continue;
    const crossed = LIMIT_THRESHOLDS[window].filter((t) => view.usedPct >= t);
    const fresh = crossed.filter((t) => {
      const prev = next[`${window}:${t}`];
      return prev === undefined || Math.abs(prev - resetsMs) >= SAME_WINDOW_TOLERANCE_MS;
    });
    if (fresh.length === 0) continue;
    for (const t of crossed) next[`${window}:${t}`] = resetsMs;
    alerts.push({ window, threshold: Math.max(...fresh), view });
  }
  return { alerts, state: next };
}

// --- sessiya bildirishnomalari ----------------------------------------------------------------

export type SessionNoticeKind = 'waiting' | 'done';

export interface NoticeContext {
  notifyDone: boolean;
  /** epoch ms; 0 = o'chirilgan. */
  mutedUntil: number;
}

const MAX_TRACKED = 2000;

/**
 * `done` xabari shuncha kechiktiriladi: `Stop` faqat bitta navbat tugaganini bildiradi, Claude ko'pincha
 * o'zi qayta ishga tushadi (fon subagent/task tugashi, inbox avto-uyg'otish). Shu vaqtdan keyin ham `done`
 * bo'lsagina "Sessiya tugadi" yuboriladi.
 */
export const DONE_NOTICE_DELAY_MS = 45_000;

export type TimerHandle = unknown;
export interface TimerScheduler {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

/** Haqiqiy taymerlar (unref: jarayonni ushlab turmaydi). */
export const realScheduler: TimerScheduler = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Sessiya bo'yicha BITTA kutilayotgan `done` tekshiruvi: yangi `done` eskisini almashtiradi,
 * `done` bo'lmagan har qanday holat bekor qiladi. Taymer o'z-o'zini tozalaydi.
 */
export class DoneNoticeScheduler {
  private readonly pending = new Map<string, TimerHandle>();

  constructor(
    private readonly delayMs: number = DONE_NOTICE_DELAY_MS,
    private readonly scheduler: TimerScheduler = realScheduler,
  ) {}

  schedule(sessionId: string, fire: () => void): void {
    this.cancel(sessionId);
    const handle = this.scheduler.set(() => {
      this.pending.delete(sessionId);
      fire();
    }, this.delayMs);
    this.pending.set(sessionId, handle);
  }

  cancel(sessionId: string): void {
    const h = this.pending.get(sessionId);
    if (h === undefined) return;
    this.scheduler.clear(h);
    this.pending.delete(sessionId);
  }

  clearAll(): void {
    for (const h of this.pending.values()) this.scheduler.clear(h);
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Sessiya holat o'tishlari uchun to'siq: faqat HAQIQIY o'tish (waiting/done ga), birinchi ko'rilganda jim
 * (restartdan keyin eski holat uchun xabar yog'ilmasin), sessiya bo'yicha eng kami `minGapMs`, mute va
 * `notify done` ga bo'ysunadi.
 */
export class SessionNoticeGate {
  private readonly seen = new Map<string, { status: SessionStatus; lastNoticeAt: number }>();

  constructor(private readonly minGapMs = 60_000) {}

  /** Boshlang'ich holatni yozadi (mavjudini bosmaydi). */
  seed(sessionId: string, status: SessionStatus): void {
    if (!this.seen.has(sessionId)) this.remember(sessionId, { status, lastNoticeAt: 0 });
  }

  /** Holatni qayd etadi. Bildirishnoma nomzodi bo'lsa turini qaytaradi (admit() dan oldin qo'shimcha tekshiruvlar uchun). */
  observe(sessionId: string, status: SessionStatus): SessionNoticeKind | null {
    const prev = this.seen.get(sessionId);
    this.remember(sessionId, { status, lastNoticeAt: prev?.lastNoticeAt ?? 0 });
    if (!prev || prev.status === status) return null;
    return status === 'waiting' || status === 'done' ? status : null;
  }

  /** mute / notify / tezlik chegarasi. `true` bo'lsa yuboriladi va vaqt belgilanadi. */
  admit(sessionId: string, kind: SessionNoticeKind, now: number, ctx: NoticeContext): boolean {
    if (kind === 'done' && !ctx.notifyDone) return false;
    if (now < ctx.mutedUntil) return false;
    const rec = this.seen.get(sessionId);
    if (!rec) return false;
    if (rec.lastNoticeAt > 0 && now - rec.lastNoticeAt < this.minGapMs) return false;
    rec.lastNoticeAt = now;
    return true;
  }

  private remember(id: string, rec: { status: SessionStatus; lastNoticeAt: number }): void {
    this.seen.delete(id); // tartibni yangilaydi (eng eskisi birinchi)
    this.seen.set(id, rec);
    if (this.seen.size > MAX_TRACKED) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

// --- mashina offline kuzatuvi -----------------------------------------------------------------

interface MachineState {
  online: boolean;
  offlineSince: number | null;
  alerted: boolean;
  /** Markaz ishga tushishi bilan bog'liq offline (hamma agentd qayta ulanadi): ogohlantirish ham, "qayta ulandi" ham yo'q. */
  silent: boolean;
}

/**
 * Mashina 2 daqiqadan uzoq offline bo'lsa BIR marta ogohlantirish; qaytsa BIR marta xabar. Markaz o'zi
 * ishga tushganda `resetAllOffline` hamma mashinani offline qiladi va agentd'lar qayta ulanadi: shu oraliq
 * (`graceMs`) va boshlang'ich offline holatlar "jim" belgilanadi.
 */
export class MachineWatch {
  private readonly machines = new Map<string, MachineState>();

  constructor(
    private readonly bootAt: number,
    private readonly graceMs = 90_000,
    private readonly offlineAfterMs = 120_000,
  ) {}

  /** `'back_online'` — ilgari offline ogohlantirilgan mashina qaytdi. */
  observe(machineId: string, online: boolean, now: number): 'back_online' | null {
    const prev = this.machines.get(machineId);
    if (!prev) {
      this.machines.set(machineId, { online, offlineSince: online ? null : now, alerted: false, silent: !online });
      return null;
    }
    if (online) {
      const back = !prev.online && prev.alerted && !prev.silent;
      this.machines.set(machineId, { online: true, offlineSince: null, alerted: false, silent: false });
      return back ? 'back_online' : null;
    }
    if (prev.online) {
      this.machines.set(machineId, { online: false, offlineSince: now, alerted: false, silent: now - this.bootAt < this.graceMs });
    }
    return null;
  }

  /** Offline ogohlantirishi kerak bo'lgan mashinalar (har biri bir marta). */
  due(now: number): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.machines) {
      if (!s.online && !s.alerted && !s.silent && s.offlineSince !== null && now - s.offlineSince >= this.offlineAfterMs) {
        s.alerted = true;
        ids.push(id);
      }
    }
    return ids;
  }
}
