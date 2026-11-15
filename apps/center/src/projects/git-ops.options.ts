import { GIT_OPS_LIMITS } from '@commander/contracts';

export const GIT_OPS_OPTIONS = Symbol('GIT_OPS_OPTIONS');

export interface GitOpsOptions {
  /** CI davriy so'rovi oralig'i (ms); 0 = o'chiq (testlar). */
  ciPollMs: number;
}

export function gitOpsOptionsFromEnv(): GitOpsOptions {
  return { ciPollMs: process.env['VITEST'] ? 0 : GIT_OPS_LIMITS.ciPollMs };
}
