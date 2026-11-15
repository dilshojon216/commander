import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  APPROVAL_LIMITS,
  ApprovalRequestPayloadSchema,
  QUESTION_TOOL_NAME,
  type ApprovalCancelPayload,
  type ApprovalDecisionPayload,
  type ApprovalExpiredPayload,
  type ApprovalRequestPayload,
} from '@commander/contracts';
import { PERMISSION_DEADLINE, type PermissionIpcDecision, type PermissionIpcReply } from '@commander/contracts/ipc';
import { prepareQuestionRequest, preparePlanRequest, prepareToolInput } from './approval-input.js';
import { computeApprovalTarget } from './approval-target.js';
import type { Logger } from './logger.js';

/** cc-hook ulanishi (hook-server beradi). `reply` bir marta ishlaydi va ulanishni yopadi. */
export interface HookConn {
  reply(r: PermissionIpcReply): void;
  onClose(cb: () => void): void;
}

/** WS klient ko'prigi (daemon `AgentWsClient`ni shu interfeysga moslaydi). */
export interface ApprovalTransport {
  isReady(): boolean;
  /** Xabar id'si yoki yuborib bo'lmasa `undefined`. */
  send(type: 'approval.request' | 'approval.cancel', payload: unknown): string | undefined;
}

export interface ApprovalManagerDeps {
  log: Logger;
  now?: () => number;
  /** cwd -> loyiha ildizi (hodisalar bilan bir xil ko'rinish). */
  resolveCwd?: (cwd: string) => string | undefined;
  /** So'rov qabul qilinganda (sessiya `awaiting_approval` hodisasi shu yerda chiqariladi). */
  onRequested?: (rawPayload: unknown) => void;
  /** Hal bo'lganda (lokal holatni tiklash uchun). */
  onSettled?: (sessionId: string, outcome: 'decided' | 'expired' | 'cancelled') => void;
  /** Center aloqasi yo'q bo'lsa hook'ni shuncha ms'dan keyin qo'yib yuborish. */
  connectGraceMs?: number;
  maxPending?: number;
}

/** Hook JSON'idan kerakli maydonlar (qolganlari e'tiborsiz). `tool_use_id` PermissionRequest'da YO'Q (hujjat). */
const PermissionPayloadSchema = z.looseObject({
  session_id: z.string().min(1).max(255),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  cwd: z.string().min(1).max(4096).nullish(),
});

const SessionHookSchema = z.looseObject({
  hook_event_name: z.string().min(1).max(64),
  session_id: z.string().min(1).max(255),
  tool_name: z.string().nullish(),
  agent_id: z.string().nullish(),
});

/** Shu hodisalar kelsa, kutayotgan so'rov lokal hal bo'lgan (yoki sessiya davom etgan) deb hisoblanadi. */
const CANCEL_ON_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit', 'SessionEnd']);
const TOOL_SCOPED_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);

interface Pending {
  id: string;
  sessionId: string;
  toolName: string;
  deadline: number;
  conn: HookConn;
  settled: boolean;
  /** Center'ga kamida bir marta yuborilgan (ack'dan keyin navbat elementi o'chadi, shuning uchun alohida belgi). */
  sentToCenter: boolean;
  timer: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
}

interface QueueItem {
  kind: 'request' | 'cancel';
  approvalId: string;
  payload: ApprovalRequestPayload | ApprovalCancelPayload;
  /** Shundan keyin yuborilmaydi (request: deadline; cancel: deadline). */
  expiresAt: number;
  msgId?: string;
  everSent: boolean;
  retryAt?: number;
}

const NULL = (reason: string): PermissionIpcReply => ({ ok: true, decision: null, reason });

/**
 * Remote permission holat mashinasi (agentd tomoni). Qoidalar (CLAUDE.md 4):
 *  - `allow`/`deny` faqat center'dan kelgan `approval.decision` bilan; boshqa HAR QANDAY yo'l `decision: null`;
 *  - so'rov deadline'gacha qayta yuboriladi (reconnect), keyin tashlanadi;
 *  - hook uzilsa yoki shu sessiyada keyingi hodisa kelsa: lokal hal bo'ldi => `approval.cancel`.
 * Xotirada saqlanadi: agentd o'lsa cc-hook ulanishi ham uziladi va Claude lokal promptga qaytadi.
 */
export class ApprovalManager {
  private readonly pending = new Map<string, Pending>();
  private readonly queue = new Map<string, QueueItem>();
  private transport: ApprovalTransport | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly d: ApprovalManagerDeps) {
    this.now = d.now ?? Date.now;
  }

  attach(transport: ApprovalTransport): void {
    this.transport = transport;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  // --- cc-hook tomoni ---

  /** `deadlineMs` cc-hook'dan (ishonchsiz kirish): chegaralanadi. Hech qachon tashlamaydi. */
  request(rawPayload: unknown, deadlineMs: unknown, conn: HookConn): void {
    try {
      this.doRequest(rawPayload, deadlineMs, conn);
    } catch (err) {
      this.d.log.error('approval so\'rovini qayta ishlashda xato', { error: err instanceof Error ? err.message : String(err) });
      conn.reply(NULL('internal'));
    }
  }

  private doRequest(rawPayload: unknown, deadlineMsRaw: unknown, conn: HookConn): void {
    const parsed = PermissionPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) return conn.reply(NULL('bad_request'));
    const p = parsed.data;
    if (this.pending.size >= (this.d.maxPending ?? 50)) return conn.reply(NULL('too_many_pending'));

    const t = this.now();
    const ms = clampDeadline(deadlineMsRaw);
    const deadline = t + ms;
    const full = prepareToolInput(p.tool_input);
    const hash = full.hash;
    // AskUserQuestion (6.13): strukturali savollar. Tuzilma noaniq bo'lsa markazga UMUMAN yuborilmaydi (lokal dialog qoladi).
    const questionReq = prepareQuestionRequest(p.tool_name, p.tool_input);
    if (p.tool_name === QUESTION_TOOL_NAME && !questionReq) return conn.reply(NULL('unsupported_question'));
    // ExitPlanMode (2.14): reja alohida maydonda (16 KB), kiritma nusxasi rejasiz. Boshqa vositalar: oddiy yo'l.
    const planReq = preparePlanRequest(p.tool_name, p.tool_input);
    // Savol so'rovida xom kiritma matni markazga YUBORILMAYDI (savollar strukturali `questions`da; hash to'liq xomdan).
    const redacted = questionReq ? '' : planReq ? prepareToolInput(planReq.restInput).redacted : full.redacted;
    // Avto-ruxsat maslahati (2.13): xom kiritmadan, faqat nisbiy yo'l + cwd ichidami (xom matn markazga ketmaydi).
    const target = computeApprovalTarget(p.tool_name, p.tool_input, p.cwd);
    const cwdRaw = p.cwd ?? '';
    const cwd = (cwdRaw && (this.d.resolveCwd?.(cwdRaw) ?? cwdRaw)) || '/unknown';
    const approvalId = randomUUID();
    const req = ApprovalRequestPayloadSchema.safeParse({
      approvalId,
      claudeSessionId: p.session_id,
      toolName: p.tool_name.slice(0, APPROVAL_LIMITS.toolNameMaxChars),
      toolInputRedacted: redacted,
      toolInputFullHash: hash,
      cwd,
      deadline,
      ...(planReq ? { kind: 'plan' as const, plan: planReq.plan } : {}),
      ...(questionReq ? { kind: 'question' as const, questions: questionReq.questions } : {}),
      ...(target ? { target } : {}),
    });
    if (!req.success) return conn.reply(NULL('bad_request'));

    try {
      this.d.onRequested?.(rawPayload);
    } catch (err) {
      this.d.log.warn('onRequested xatosi', { error: err instanceof Error ? err.message : String(err) });
    }

    const entry: Pending = {
      id: approvalId,
      sessionId: p.session_id,
      toolName: p.tool_name,
      deadline,
      conn,
      settled: false,
      sentToCenter: false,
      timer: setTimeout(() => this.settle(approvalId, NULL('expired'), 'expired'), ms),
    };
    entry.timer.unref();
    this.pending.set(approvalId, entry);
    conn.onClose(() => this.onHookClosed(approvalId));
    this.queue.set(`request:${approvalId}`, { kind: 'request', approvalId, payload: req.data, expiresAt: deadline, everSent: false });

    if (!this.transport?.isReady()) {
      entry.graceTimer = setTimeout(() => {
        const item = this.queue.get(`request:${approvalId}`);
        if (item && !item.everSent) this.settle(approvalId, NULL('center_offline'), 'expired');
      }, this.d.connectGraceMs ?? 3000);
      entry.graceTimer.unref();
    }
    this.flush();
  }

  private onHookClosed(id: string): void {
    const e = this.pending.get(id);
    if (!e || e.settled) return; // o'zimiz javob berib yopganmiz
    this.d.log.info('cc-hook uzildi: lokal hal bo\'ldi deb bekor qilinadi', { approvalId: id });
    this.cancel(id, 'hook_exited');
  }

  /** Shu sessiyaning keyingi hodisasi (status hook'lari) kelganda. Subagent hodisalari e'tiborsiz. */
  onSessionHook(rawPayload: unknown): void {
    if (this.pending.size === 0) return;
    const p = SessionHookSchema.safeParse(rawPayload);
    if (!p.success || p.data.agent_id) return;
    const ev = p.data.hook_event_name;
    if (!CANCEL_ON_EVENTS.has(ev)) return;
    for (const e of [...this.pending.values()]) {
      if (e.sessionId !== p.data.session_id) continue;
      // Parallel tool'lar: boshqa tool'ning hodisasi bu so'rovni hal qilmaydi (tool_use_id PermissionRequest'da yo'q, nom bo'yicha).
      if (TOOL_SCOPED_EVENTS.has(ev) && p.data.tool_name && p.data.tool_name !== e.toolName) continue;
      this.cancel(e.id, 'resolved_locally');
    }
  }

  // --- center tomoni ---

  onDecision(msg: ApprovalDecisionPayload): void {
    const e = this.pending.get(msg.approvalId);
    if (!e) {
      this.d.log.debug('approval.decision: kutayotgan so\'rov yo\'q (lokal hal bo\'lgan yoki muddati o\'tgan)', { approvalId: msg.approvalId });
      return;
    }
    if (this.now() > e.deadline) return; // taymer hozir ishlaydi; kech qarorni qabul qilmaymiz
    const decision: PermissionIpcDecision =
      msg.behavior === 'allow'
        ? { behavior: 'allow', ...(msg.answers && e.toolName === QUESTION_TOOL_NAME ? { answers: msg.answers.map((a) => ({ q: a.q, picks: a.picks, ...(a.other !== undefined ? { other: a.other } : {}) })) } : {}) }
        : { behavior: 'deny', ...(msg.message ? { message: msg.message } : {}) };
    this.settle(e.id, { ok: true, decision }, 'decided');
  }

  onExpired(msg: ApprovalExpiredPayload): void {
    if (this.pending.has(msg.approvalId)) this.settle(msg.approvalId, NULL('expired'), 'expired');
  }

  // --- WS ko'prigi ---

  onReady(): void {
    for (const e of this.pending.values()) {
      if (e.graceTimer) clearTimeout(e.graceTimer);
      delete e.graceTimer;
    }
    this.flush();
  }

  /** Ulanish uzildi: ack kelmagan xabarlar qayta ulanganda qayta yuboriladi (center idempotent). */
  onClosed(): void {
    for (const item of this.queue.values()) delete item.msgId;
  }

  onAck(ids: string[]): void {
    for (const [key, item] of this.queue) if (item.msgId && ids.includes(item.msgId)) this.queue.delete(key);
  }

  /** `true` = bu xabar approval navbatiga tegishli edi. */
  onNack(p: { id?: string | undefined; code: string; retriable: boolean; retryAfterMs?: number | undefined }): boolean {
    if (!p.id) return false;
    for (const [key, item] of this.queue) {
      if (item.msgId !== p.id) continue;
      if (p.retriable) {
        delete item.msgId;
        item.retryAt = this.now() + Math.max(p.retryAfterMs ?? 0, 2000);
        this.scheduleFlush(item.retryAt - this.now());
      } else {
        this.queue.delete(key);
        this.d.log.warn('center approval xabarini rad etdi', { code: p.code, kind: item.kind });
        if (item.kind === 'request') this.settle(item.approvalId, NULL('rejected_by_center'), 'expired');
      }
      return true;
    }
    return false;
  }

  /** Daemon to'xtaganda: kutayotganlarni qo'yib yuboradi (lokal prompt). */
  stop(): void {
    for (const e of [...this.pending.values()]) this.settle(e.id, NULL('agentd_stopping'), 'expired');
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  // --- ichki ---

  private cancel(id: string, reason: string): void {
    const e = this.pending.get(id);
    if (!e) return;
    this.queue.delete(`request:${id}`);
    // Markazga hech qachon yetmagan so'rovni bekor qilishga hojat yo'q.
    if (e.sentToCenter) {
      this.queue.set(`cancel:${id}`, { kind: 'cancel', approvalId: id, payload: { approvalId: id, reason }, expiresAt: e.deadline, everSent: false });
    }
    this.settle(id, NULL(reason), 'cancelled');
    this.flush();
  }

  private settle(id: string, reply: PermissionIpcReply, outcome: 'decided' | 'expired' | 'cancelled'): void {
    const e = this.pending.get(id);
    if (!e || e.settled) return;
    e.settled = true;
    clearTimeout(e.timer);
    if (e.graceTimer) clearTimeout(e.graceTimer);
    this.pending.delete(id);
    this.queue.delete(`request:${id}`); // center o'zi expire qiladi / qaror allaqachon uning qo'lida
    try {
      e.conn.reply(reply);
    } catch (err) {
      this.d.log.warn('hook ulanishiga javob yozilmadi', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      this.d.onSettled?.(e.sessionId, outcome);
    } catch (err) {
      this.d.log.warn('onSettled xatosi', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private flush(): void {
    const t = this.now();
    let nextWake: number | null = null;
    for (const [key, item] of [...this.queue]) {
      if (item.expiresAt <= t) {
        this.queue.delete(key); // deadline o'tdi: outbox'dan tashlanadi
        continue;
      }
      if (item.msgId) continue;
      if (item.retryAt && item.retryAt > t) {
        nextWake = Math.min(nextWake ?? item.retryAt - t, item.retryAt - t);
        continue;
      }
      const tr = this.transport;
      if (!tr?.isReady()) continue;
      const id = tr.send(item.kind === 'request' ? 'approval.request' : 'approval.cancel', item.payload);
      if (!id) continue;
      item.msgId = id;
      item.everSent = true;
      if (item.kind === 'request') {
        const e = this.pending.get(item.approvalId);
        if (e) e.sentToCenter = true;
        if (e?.graceTimer) {
          clearTimeout(e.graceTimer);
          delete e.graceTimer;
        }
      }
    }
    // Eng yaqin deadline'da navbatni tozalash.
    for (const item of this.queue.values()) nextWake = Math.min(nextWake ?? item.expiresAt - t, item.expiresAt - t);
    if (nextWake !== null) this.scheduleFlush(Math.max(50, nextWake));
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, ms);
    this.flushTimer.unref();
  }
}

export function clampDeadline(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : PERMISSION_DEADLINE.defaultMs;
  return Math.min(PERMISSION_DEADLINE.maxMs, Math.max(PERMISSION_DEADLINE.minMs, n));
}
