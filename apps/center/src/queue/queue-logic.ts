import { QUEUE_LIMITS } from '@commander/contracts';
import type { QueueStatus, QueueTrigger, RemotePermissionMode } from '@commander/contracts';
import { nextCronRun, validateCron } from './cron.js';

/** Navbat sof mantig'i (DB'siz): tasdiq qoidasi, trigger tekshiruvi/rejalash, ishga tushirish qarori, natija tasnifi. */

export type QueueConfirmation = 'exempt_device' | 'telegram_inline';

/**
 * Yaratish paytidagi step-up: `session.start` bilan BIR XIL qoida (commands.service). `session.start` har doim step-up talab qiladi;
 * o'tish yo'llari: (1) istisno qurilma (Mac dashboard) va rejim `auto` EMAS; (2) Telegram chat ichidagi tasdiq (`auto` ham, alohida tugma bilan).
 * Boshqa hamma holat = null (rad): navbat elementi sukut bilan tasdiqlanmaydi.
 */
export function confirmationFor(i: { mode: RemotePermissionMode; exemptDevice: boolean; actorKind: string; inline: boolean }): QueueConfirmation | null {
  if (i.actorKind === 'telegram' && i.inline) return 'telegram_inline';
  if (i.mode !== 'auto' && i.exemptDevice) return 'exempt_device';
  return null;
}

export interface Schedule {
  status: QueueStatus;
  nextRunAt: Date | null;
}

export class TriggerError extends Error {
  constructor(
    readonly code: 'invalid_trigger' | 'invalid_cron' | 'at_in_past' | 'at_too_far',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Triggerni tekshiradi va birinchi rejani qaytaradi.
 *  - now: darhol (`queued`); at: shu vaqt; cron: keyingi chiqish; limit_reset: berilgan oyna reset vaqti (noma'lum bo'lsa null: scheduler keyin bog'laydi);
 *  - machine_idle: `waiting_trigger`, scheduler har tikda tekshiradi.
 */
export function scheduleFor(trigger: QueueTrigger, now: Date, limitResetAt: Date | null): Schedule {
  switch (trigger.type) {
    case 'now':
      return { status: 'queued', nextRunAt: now };
    case 'at': {
      const at = new Date(trigger.at);
      if (at.getTime() < now.getTime() - 60_000) throw new TriggerError('at_in_past', 'The time is in the past');
      if (at.getTime() > now.getTime() + QUEUE_LIMITS.maxAtDays * 86_400_000) throw new TriggerError('at_too_far', `The time is more than ${QUEUE_LIMITS.maxAtDays} days ahead`);
      return { status: 'waiting_trigger', nextRunAt: at };
    }
    case 'cron': {
      const err = validateCron(trigger.cron);
      if (err) throw new TriggerError('invalid_cron', err);
      const next = nextCronRun(trigger.cron, now);
      if (!next) throw new TriggerError('invalid_cron', 'The expression never fires');
      return { status: 'waiting_trigger', nextRunAt: next };
    }
    case 'limit_reset':
      return { status: 'waiting_trigger', nextRunAt: limitResetAt };
    case 'machine_idle':
      return { status: 'waiting_trigger', nextRunAt: now };
  }
}

/** Limit yangilangandan keyin biroz kutiladi: yangi kuzatuv kelib ulgursin. */
export const LIMIT_RESET_SLACK_MS = 60_000;

export const DEFER_MS = {
  lockdown: 5 * 60_000,
  offline: 5 * 60_000,
  concurrency: 5 * 60_000,
  exhausted: 10 * 60_000,
  busy: 60_000,
} as const;

export interface FireContext {
  lockdown: boolean;
  machineOnline: boolean;
  /** Mashinada biz ochgan va hozir tirik sessiyalar soni va siyosat chegarasi (null = chegara noma'lum). */
  activeRemote: number;
  maxConcurrent: number | null;
  /** 5 soatlik oyna hozir tugaydi (`exhaustsWithin`) va sozlama bloklashni talab qiladi. */
  limitExhausted: boolean;
  attempts: number;
  maxAttempts: number;
  isCron: boolean;
  /** machine_idle triggeri uchun: mashinada ish ketayotgan sessiya bormi. */
  machineBusy: boolean;
  triggerType: QueueTrigger['type'];
  /** Markaz bo'yicha bir vaqtda `starting` elementlar chegarasi. */
  startingNow: number;
  maxStartingNow: number;
  /** 6.11: loyiha/mashina kunlik byudjeti tugagan (qattiq chegara): navbat elementi yarim kechagacha/oshirilguncha kutadi (urinish sanalmaydi). */
  budgetExceeded?: boolean;
  /** 6.12: haftalik limit tezligi ulushi tugagan va majburlash yoqilgan: element yarim kechagacha/ruxsat berilguncha kutadi (urinish sanalmaydi). */
  paceExceeded?: boolean;
}

export type FireDecision =
  | { kind: 'fire' }
  | { kind: 'defer'; code: string; delayMs: number; countAttempt: boolean }
  | { kind: 'fail'; code: string }
  /** Takroriy element: bu chiqish o'tkazib yuboriladi (tarixga `skipped`), keyingisiga o'tiladi. */
  | { kind: 'skip_occurrence'; code: string };

export function decideFire(c: FireContext): FireDecision {
  if (c.lockdown) return { kind: 'defer', code: 'lockdown', delayMs: DEFER_MS.lockdown, countAttempt: false };
  if (c.triggerType === 'machine_idle' && c.machineBusy) return { kind: 'defer', code: 'machine_busy', delayMs: DEFER_MS.busy, countAttempt: false };
  if (!c.machineOnline) {
    const attempts = c.attempts + 1;
    if (attempts >= c.maxAttempts) return c.isCron ? { kind: 'skip_occurrence', code: 'machine_offline' } : { kind: 'fail', code: 'machine_offline' };
    return { kind: 'defer', code: 'machine_offline', delayMs: DEFER_MS.offline, countAttempt: true };
  }
  if (c.maxConcurrent !== null && c.activeRemote >= c.maxConcurrent) return { kind: 'defer', code: 'too_many_sessions', delayMs: DEFER_MS.concurrency, countAttempt: false };
  if (c.limitExhausted) return { kind: 'defer', code: 'limit_exhausted', delayMs: DEFER_MS.exhausted, countAttempt: false };
  if (c.budgetExceeded) return { kind: 'defer', code: 'budget_exceeded', delayMs: DEFER_MS.exhausted, countAttempt: false };
  if (c.paceExceeded) return { kind: 'defer', code: 'weekly_pace_exceeded', delayMs: DEFER_MS.exhausted, countAttempt: false };
  if (c.startingNow >= c.maxStartingNow) return { kind: 'defer', code: 'queue_busy', delayMs: DEFER_MS.busy, countAttempt: false };
  return { kind: 'fire' };
}

/** Yaratilgan `session.start` buyrug'ining holatiga qarab navbat elementi/ishga tushish natijasi. */
export type RunOutcome = { kind: 'pending' } | { kind: 'started' } | { kind: 'retry'; code: string } | { kind: 'failed'; code: string };

const RETRYABLE = new Set(['machine_offline', 'agent_timeout', 'dispatch_expired', 'center_restarted', 'too_many_sessions', 'lockdown', 'weekly_pace_exceeded']);

export function classifyCommand(status: string, errorCode: string | null): RunOutcome {
  if (status === 'done') return { kind: 'started' };
  if (status === 'failed' || status === 'expired' || status === 'rejected') {
    const code = errorCode ?? status;
    return RETRYABLE.has(code) ? { kind: 'retry', code } : { kind: 'failed', code };
  }
  return { kind: 'pending' };
}

/** Takroriy element uchun fire'dan keyingi reja. */
export function nextAfterFire(trigger: QueueTrigger, firedAt: Date): Date | null {
  return trigger.type === 'cron' ? nextCronRun(trigger.cron, firedAt) : null;
}

/** Idempotentlik kaliti: element + tartib raqami (`Idempotency-Key` formati: 8-128 belgi [A-Za-z0-9_.:-]). */
export const fireKey = (itemId: string, seq: number): string => `queue-${itemId}-${seq}`;
