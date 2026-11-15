import { APPROVAL_LIMITS } from '@commander/contracts';
import type { ApprovalBehavior, ApprovalStatus } from '@commander/contracts';

/** Holat mashinasi (sof mantiq; DB va I/O yo'q). PLAN 6.4 qoida 4: birinchi qaror yutadi. */

export const TERMINAL_STATUSES: readonly ApprovalStatus[] = ['approved', 'denied', 'expired', 'cancelled'];
export const isTerminal = (s: ApprovalStatus): boolean => TERMINAL_STATUSES.includes(s);

export const statusForBehavior = (b: ApprovalBehavior): 'approved' | 'denied' => (b === 'allow' ? 'approved' : 'denied');
export const behaviorForStatus = (s: ApprovalStatus): ApprovalBehavior | null => (s === 'approved' ? 'allow' : s === 'denied' ? 'deny' : null);

export interface DecidableApproval {
  status: ApprovalStatus;
  deadline: Date;
  decidedByDeviceId: string | null;
}

export interface DecideRequest {
  behavior: ApprovalBehavior;
  deviceId: string;
  now: Date;
  /** Lockdown yoqilganmi: masofaviy `allow` rad etiladi, `deny` ruxsat (xavfsiz tomonga xato). */
  lockdown: boolean;
}

export type DecideOutcome =
  | { kind: 'apply'; status: 'approved' | 'denied' }
  /** Shu qurilma xuddi shu qarorni allaqachon bergan: xavfsiz qayta urinish (200, yangi amal yo'q). */
  | { kind: 'idempotent' }
  /** Boshqa qaror yoki boshqa qurilma yoki so'rov yakunlangan (expired/cancelled): 409. */
  | { kind: 'conflict'; current: ApprovalStatus }
  /** Deadline o'tgan (sweeper hali ulgurmagan bo'lishi mumkin): chaqiruvchi `expired` qiladi, 409. */
  | { kind: 'expired' }
  | { kind: 'lockdown_allow_refused' };

export function decideApproval(a: DecidableApproval, req: DecideRequest): DecideOutcome {
  if (a.status === 'pending') {
    if (a.deadline.getTime() <= req.now.getTime()) return { kind: 'expired' };
    if (req.lockdown && req.behavior === 'allow') return { kind: 'lockdown_allow_refused' };
    return { kind: 'apply', status: statusForBehavior(req.behavior) };
  }
  if ((a.status === 'approved' || a.status === 'denied') && a.decidedByDeviceId === req.deviceId && behaviorForStatus(a.status) === req.behavior) {
    return { kind: 'idempotent' };
  }
  return { kind: 'conflict', current: a.status };
}

/**
 * Yakuniy holatdan keyin sessiyaning `awaiting_approval` holati nimaga qaytadi (boshqa pending qolmasa):
 * qaror/bekor -> `working` (tool bajariladi yoki Claude rad javobini oladi; keyingi agent hodisasi aniqlashtiradi);
 * expired -> `waiting` (lokal ruxsat dialogi hamon ochiq: foydalanuvchi javobini kutadi).
 */
export function sessionStatusAfter(s: ApprovalStatus): 'working' | 'waiting' {
  return s === 'expired' ? 'waiting' : 'working';
}

/** Agent bergan deadline'ni markaz qoidasiga keltiradi: eng uzun `maxDeadlineMs`; o'tib ketgan = darhol expired. */
export function normalizeDeadline(deadlineMs: number, now: Date): { deadline: Date; alreadyExpired: boolean } {
  const capped = Math.min(deadlineMs, now.getTime() + APPROVAL_LIMITS.maxDeadlineMs);
  return { deadline: new Date(capped), alreadyExpired: capped <= now.getTime() };
}
