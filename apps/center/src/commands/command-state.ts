import { isTerminalCommandState } from '@commander/contracts';
import type { CommandResultPayload, CommandState } from '@commander/contracts';

/**
 * Buyruq holat mashinasi (sof, DB'siz). Ruxsat etilgan o'tishlar:
 *
 *   awaiting_confirmation -> pending | rejected | expired | failed
 *   pending               -> sent | rejected | failed | expired
 *   sent                  -> acked | running | done | failed | rejected | expired
 *   acked                 -> running | done | failed | rejected
 *   running               -> done | failed
 *
 * Yakuniy holatlar (done, failed, expired, rejected) o'zgarmaydi. `sent -> done|running` ack yo'qolgan holat uchun
 * (agent ack'i va natijasi ketma-ket kelganda tartib buzilishi mumkin: ack outbox'da qolib natija oldin yetishi).
 */
const NEXT: Record<CommandState, readonly CommandState[]> = {
  awaiting_confirmation: ['pending', 'rejected', 'expired', 'failed'],
  pending: ['sent', 'rejected', 'failed', 'expired'],
  sent: ['acked', 'running', 'done', 'failed', 'rejected', 'expired'],
  acked: ['running', 'done', 'failed', 'rejected', 'expired', 'failed'],
  running: ['done', 'failed', 'expired'],
  done: [],
  failed: [],
  expired: [],
  rejected: [],
};

export function canTransition(from: CommandState, to: CommandState): boolean {
  return NEXT[from].includes(to);
}

export type ResultOutcome =
  | { kind: 'apply'; to: CommandState }
  /** Allaqachon shu holatda yoki undan keyingi/yakuniy holatda: DB o'zgarmaydi, lekin ack qilinadi (idempotent). */
  | { kind: 'noop' };

/** Agent `command.result` ni qanday holatga o'tkazish. `rejected` faqat bajarish boshlanmagan bo'lsa (sent|acked), aks holda `failed`. */
export function applyAgentResult(current: CommandState, result: Pick<CommandResultPayload, 'state'>): ResultOutcome {
  if (isTerminalCommandState(current)) return { kind: 'noop' };
  if (current === 'awaiting_confirmation' || current === 'pending') return { kind: 'noop' }; // hali dispatch qilinmagan buyruq haqida natija: ishonib bo'lmaydi
  let to: CommandState = result.state;
  if (to === 'rejected' && current === 'running') to = 'failed';
  if (to === current) return { kind: 'noop' };
  return canTransition(current, to) ? { kind: 'apply', to } : { kind: 'noop' };
}

/** Agent `command.ack`: faqat `sent -> acked`; boshqa holatlarda no-op. */
export function applyAgentAck(current: CommandState): ResultOutcome {
  return current === 'sent' ? { kind: 'apply', to: 'acked' } : { kind: 'noop' };
}
