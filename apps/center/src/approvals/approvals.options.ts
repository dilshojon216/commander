export interface ApprovalsOptions {
  /** Muddati o'tgan approval'larni tekshirish oralig'i (ms). */
  sweepMs: number;
}

export const APPROVALS_OPTIONS = Symbol('APPROVALS_OPTIONS');

export const DEFAULT_APPROVALS_OPTIONS: ApprovalsOptions = { sweepMs: 2_000 };
