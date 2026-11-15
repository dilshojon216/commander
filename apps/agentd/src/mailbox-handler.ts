import { z } from 'zod';
import { DECISION_LIMITS, MESSAGE_LIMITS, MailboxCallSchema, ORCH_LIMITS } from '@commander/contracts';
import type { MailboxReplyPayload, MessageErrorCode } from '@commander/contracts';
import type { Logger } from './logger.js';
import type { MailboxClient } from './mailbox-client.js';
import { redact } from './redact.js';
import type { SessionIdentity } from './peer-identity.js';
import type { SessionStore } from './session-store.js';

/** Lokal socket so'rovi (`kind: 'mailbox'`): cc-mcp va cc-hook yuboradi. */
export const MailboxIpcSchema = z.object({
  /** Claude session id: MCP'da `CLAUDE_CODE_SESSION_ID`, hook'da stdin `session_id`. Yo'q bo'lsa cwd bo'yicha (yagona ochiq sessiya). */
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  call: z.unknown(),
});

/** Lokal javob (cc-mcp / cc-hook o'qiydi). */
export interface MailboxIpcReply {
  ok: boolean;
  data?: unknown;
  error?: { code: MessageErrorCode; message: string };
}

/** `HookServer` ulanishi: javob bir marta. */
export interface MailboxConn {
  reply(r: MailboxIpcReply): void;
  /** Yadro tasdiqlagan peer pid'lari (M-14); transport qo'llamasa yo'q. */
  peer?: () => Promise<number[]>;
}

/** Hook'lar tez bo'lishi shart (Claude Code kutadi); vositalar uchun uzoqroq. */
const HOOK_TIMEOUT_MS = 3500;
const TOOL_TIMEOUT_MS = 8000;

const fail = (code: MessageErrorCode, message: string): MailboxIpcReply => ({ ok: false, error: { code, message } });

export interface MailboxHandlerDeps {
  client: MailboxClient;
  store: SessionStore;
  log: Logger;
  /** cwd -> loyiha ildizi (hodisalar bilan bir xil ko'rinish). */
  resolveCwd?: (cwd: string) => string | undefined;
  /**
   * M-14: sessiya identity'sini peer jarayonga bog'laydi. `enforce` rejimida sessiya FAQAT peer ajdodidan olinadi (e'lon qilingan
   * `sessionId` mos kelmasa rad); `unattested` (Windows/vosita yo'q) yoki berilmasa eski o'z-o'zidan e'lon xatti-harakati.
   */
  identity?: SessionIdentity;
}

/**
 * Lokal vositalarni (cc-mcp, cc-hook --inbox) center'ning pochta qutisiga ulaydi.
 *
 * Sessiya aniqlash (ishonchlilik tartibi): (1) so'rovdagi `sessionId` (Claude Code MCP serverga `CLAUDE_CODE_SESSION_ID`
 * beradi: Mac'da Claude Code 2.1.304 bilan tekshirilgan; hook'da stdin `session_id`); (2) zaxira: shu `cwd`dagi YAGONA
 * ochiq sessiya. Bir nechta bo'lsa taxmin QILINMAYDI (xabar noto'g'ri sessiya nomidan ketmasin).
 *
 * Matn (`subject`, `body`) markazga ketishdan oldin redakt qilinadi (CLAUDE.md qoida 5); agentd matnni diskka/logga yozmaydi.
 */
export class MailboxHandler {
  constructor(private readonly d: MailboxHandlerDeps) {}

  async handle(rawPayload: unknown, conn: MailboxConn): Promise<void> {
    try {
      conn.reply(await this.run(rawPayload, conn));
    } catch (err) {
      this.d.log.error('mailbox handler xatosi', { error: err instanceof Error ? err.message : String(err) });
      conn.reply(fail('internal', 'agentd ichki xatosi'));
    }
  }

  private async run(rawPayload: unknown, conn: MailboxConn): Promise<MailboxIpcReply> {
    const ipc = MailboxIpcSchema.safeParse(rawPayload);
    if (!ipc.success) return fail('invalid_request', "So'rov yaroqsiz");
    const call = MailboxCallSchema.safeParse(prepare(ipc.data.call));
    if (!call.success) return fail('invalid_request', `Parametrlar yaroqsiz: ${call.error.issues.map((i) => `${i.path.join('.') || 'call'}: ${i.message}`).slice(0, 3).join('; ')}`);

    let sid: string | undefined;
    if (this.d.identity) {
      const id = await this.d.identity.verify(conn.peer, ipc.data.sessionId);
      if (!id.ok) return fail('session_unknown', `Identity check failed: ${id.reason}`);
      // enforce: sessiya faqat peer'dan; unattested: e'lon qilingani yoki (eski xatti-harakat) cwd bo'yicha yagona sessiya.
      sid = id.attested ? id.sessionId : (id.sessionId ?? this.byCwd(ipc.data.cwd));
    } else {
      sid = ipc.data.sessionId ?? this.byCwd(ipc.data.cwd);
    }
    if (!sid) return fail('session_unknown', "Sessiyani aniqlab bo'lmadi (CLAUDE_CODE_SESSION_ID yo'q va cwd bo'yicha yagona sessiya topilmadi)");

    const silent = call.data.op === 'deliver' || call.data.op === 'stop_check';
    const reply: MailboxReplyPayload = await this.d.client.request(sid, call.data, silent ? HOOK_TIMEOUT_MS : TOOL_TIMEOUT_MS);
    return reply.ok ? { ok: true, data: reply.data } : { ok: false, error: reply.error ?? { code: 'internal', message: 'Noma\'lum xato' } };
  }

  private byCwd(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined;
    const root = this.d.resolveCwd?.(cwd);
    const open = this.d.store.listOpen().filter((s) => s.cwd === cwd || (root !== undefined && (s.root === root || s.cwd === root)));
    return open.length === 1 ? open[0]?.id : undefined;
  }
}

/** `send` matnini redakt qiladi va chegaraga keltiradi (redakt uzunlikni oshirishi mumkin: Zod'dan OLDIN). */
function prepare(call: unknown): unknown {
  if (typeof call !== 'object' || call === null) return call;
  const c = call as Record<string, unknown>;
  if (c['op'] === 'record_decision') return prepareDecision(c);
  if (c['op'] === 'orch_plan' || c['op'] === 'orch_dispatch' || c['op'] === 'orch_step_update') return prepareOrch(c);
  if (c['op'] !== 'send') return call;
  const subject = typeof c['subject'] === 'string' ? redact(c['subject']).slice(0, MESSAGE_LIMITS.subjectMaxChars) : c['subject'];
  const body = typeof c['body'] === 'string' ? redact(c['body']).slice(0, MESSAGE_LIMITS.bodyMaxChars) : c['body'];
  return { ...c, subject, body };
}

/** Orkestratsiya matnlari (maqsad, qadam sarlavhalari, dispatch prompt'i, natija) ham markazga ketishdan OLDIN redakt qilinadi (qoida 5). */
function prepareOrch(c: Record<string, unknown>): unknown {
  const text = (v: unknown, max: number): unknown => (typeof v === 'string' ? redact(v).slice(0, max) : v);
  if (c['op'] === 'orch_plan') {
    const steps = Array.isArray(c['steps'])
      ? c['steps'].map((s) => (typeof s === 'object' && s !== null ? { ...(s as Record<string, unknown>), title: text((s as Record<string, unknown>)['title'], ORCH_LIMITS.titleMaxChars) } : s))
      : c['steps'];
    return { ...c, goal: text(c['goal'], ORCH_LIMITS.goalMaxChars), steps };
  }
  if (c['op'] === 'orch_dispatch') return { ...c, prompt: text(c['prompt'], ORCH_LIMITS.promptMaxChars) };
  return { ...c, summary: text(c['summary'], ORCH_LIMITS.summaryMaxChars) };
}

/** Qaror matnlari (6.3) markazga ketishdan OLDIN redakt qilinadi va cheklanadi (qoida 5). */
function prepareDecision(c: Record<string, unknown>): unknown {
  const text = (v: unknown, max: number): unknown => (typeof v === 'string' ? redact(v).slice(0, max) : v);
  const alternatives = Array.isArray(c['alternatives']) ? c['alternatives'].map((a) => text(a, DECISION_LIMITS.alternativeMaxChars)) : c['alternatives'];
  return { ...c, title: text(c['title'], DECISION_LIMITS.titleMaxChars), decision: text(c['decision'], DECISION_LIMITS.decisionMaxChars), reason: text(c['reason'], DECISION_LIMITS.reasonMaxChars), alternatives };
}
