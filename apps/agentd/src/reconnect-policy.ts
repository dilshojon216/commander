import { AGENT_WS_CLOSE } from '@commander/contracts';

/**
 * WS yopilish kodi -> qayta ulanish siyosati (center hisoboti, PLAN.md 8-bo'lim):
 *  - 4010 (revoke), 4009 (almashtirildi): QAYTA ULANMANG (aks holda ikki jarayon bir-birini quvadi / revoke qilingan qurilma urinaveradi);
 *  - 1001: server restart, darhol (backoff'siz) qayta ulaning;
 *  - 4001, 4002, 4011, 4008, 4003 va boshqalar: exponential backoff (4008/4003 uchun kattaroq minimum).
 */
export type ReconnectDecision =
  | { action: 'stop'; reason: string }
  | { action: 'immediate' }
  | { action: 'backoff'; minDelayMs: number };

export function decideReconnect(code: number): ReconnectDecision {
  switch (code) {
    case AGENT_WS_CLOSE.revoked:
      return { action: 'stop', reason: 'qurilma center tomonidan revoke qilingan (4010)' };
    case AGENT_WS_CLOSE.replaced:
      return { action: 'stop', reason: 'shu qurilma boshqa ulanish bilan almashtirildi (4009): ikkinchi agentd ishlayaptimi?' };
    case AGENT_WS_CLOSE.goingAway:
      return { action: 'immediate' };
    case AGENT_WS_CLOSE.rateLimited:
      return { action: 'backoff', minDelayMs: 30_000 };
    case AGENT_WS_CLOSE.protocolError:
    case 1009:
      return { action: 'backoff', minDelayMs: 60_000 };
    case AGENT_WS_CLOSE.authFailed:
      return { action: 'backoff', minDelayMs: 5_000 };
    default:
      return { action: 'backoff', minDelayMs: 0 };
  }
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** [0,1) tasodifiy son; testlarda almashtiriladi. */
  random?: () => number;
}

/**
 * Exponential backoff ("equal jitter"): kutish = cap/2 + random * cap/2, cap = min(max, base * 2^attempt).
 * `attempt` 0 dan boshlanadi.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const cap = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.round(cap / 2 + random() * (cap / 2));
}
