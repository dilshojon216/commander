import { randomUUID } from 'node:crypto';
import { MailboxReplyPayloadSchema } from '@commander/contracts';
import type { MailboxCall, MailboxReplyPayload } from '@commander/contracts';
import type { Logger } from './logger.js';

/** WS klient ko'prigi (daemon `AgentWsClient`ni shu interfeysga moslaydi). Jonli: ack/outbox YO'Q. */
export interface MailboxTransport {
  isReady(): boolean;
  send(type: 'mailbox.request', payload: unknown): boolean;
}

interface Pending {
  resolve: (r: MailboxReplyPayload) => void;
  timer: NodeJS.Timeout;
}

/**
 * center'ga jonli so'rov/javob (task 2.10). `mailbox.request` yuboriladi, `mailbox.reply` `reqId` bo'yicha juftlanadi.
 * Center offline yoki javob muddatida kelmasa `ok:false` (`center_offline` / `center_offline` timeout): hech qachon tashlamaydi
 * va hech narsa saqlamaydi (xabar matni agentd'da diskka yozilmaydi: outbox/log yo'q).
 */
export class MailboxClient {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly transport: MailboxTransport,
    private readonly log: Logger,
  ) {}

  request(claudeSessionId: string, call: MailboxCall, timeoutMs: number): Promise<MailboxReplyPayload> {
    const reqId = randomUUID();
    if (!this.transport.isReady()) return Promise.resolve(offline(reqId));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(offline(reqId));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      const sent = this.transport.send('mailbox.request', { reqId, claudeSessionId, call });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        resolve(offline(reqId));
      }
    });
  }

  /** `mailbox.reply` keldi. Noma'lum/kechikkan reqId e'tiborsiz. */
  onReply(raw: unknown): void {
    const parsed = MailboxReplyPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("mailbox.reply yaroqsiz, e'tiborsiz");
      return;
    }
    const p = this.pending.get(parsed.data.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(parsed.data.reqId);
    p.resolve(parsed.data);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  stop(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(offline(id));
    }
    this.pending.clear();
  }
}

function offline(reqId: string): MailboxReplyPayload {
  return { reqId, ok: false, error: { code: 'center_offline', message: "Center bilan aloqa yo'q (agentd offline yoki javob kelmadi)" } };
}
