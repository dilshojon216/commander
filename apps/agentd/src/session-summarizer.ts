import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SESSION_SUMMARY_SYSTEM_PROMPT, SessionSummaryPayloadSchema, SummaryCheckResultSchema, parseSessionSummaryOutput } from '@commander/contracts';
import type { MailboxCall, MailboxReplyPayload, SessionSummaryPayload, SummaryTrigger } from '@commander/contracts';
import { runHaiku } from './haiku-oneshot.js';
import type { Logger } from './logger.js';
import { errMsg } from './logger.js';
import { redact, redactChatText } from './redact.js';
import { buildSummaryInput, readTranscriptItems } from './session-summary-input.js';
import type { SessionRow, SessionStore } from './session-store.js';

/**
 * Sessiya xulosalari (6.1). Sessiya tugaganda (`SessionEnd`) yoki ish qilingandan keyin 10 daqiqadan ortiq tinch tursa,
 * shu mashinadagi agentd transcript'dan LOKAL xulosa yaratadi (haiku, vositasiz, bo'sh papkada; transcript mashinadan CHIQMAYDI)
 * va markazga faqat redakt qilingan natijani yuboradi (mailbox op `session_summary`).
 *
 * Markaz yagona haqiqat manbai: xulosa ishga tushirishdan OLDIN `summary_check` (global/mashina/loyiha o'chirilganmi, kunlik chegara,
 * minimal prompt/token). Markaz offline bo'lsa hech narsa ishga tushmaydi (limit tejaladi) va keyingi aylanishda qayta uriniladi.
 * Lokal o'chirish: `~/.commander/config.json` da `summaries: false`. Qo'shimcha lokal xavfsizlik chegarasi: kuniga `LOCAL_DAILY_MAX`.
 */

const IDLE_MS = 10 * 60_000;
const ENDED_WINDOW_MS = 24 * 3600_000;
const MIN_GROWTH_BYTES = 6 * 1024;
const MIN_GROWTH_ENDED_BYTES = 1024;
const LOCAL_DAILY_MAX = 100;
const HAIKU_TIMEOUT_MS = 100_000;
const CHECK_TIMEOUT_MS = 6000;
const SEND_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;

interface State {
  size: number;
  at: number;
  /** Shu vaqtgacha qayta urinmaymiz (markaz rad etgan yoki haiku muvaffaqiyatsiz). */
  retryAt?: number;
  attempts?: number;
}

export interface MailboxLike {
  request(claudeSessionId: string, call: MailboxCall, timeoutMs: number): Promise<MailboxReplyPayload>;
}

export interface SummarizerDeps {
  db: DatabaseSync;
  store: SessionStore;
  mailbox: MailboxLike;
  log: Logger;
  claudeBin: string;
  /** Bo'sh papka (`~/.commander/summarize`). */
  dir: string;
  /** Lokal o'chirish (config `summaries: false`). */
  enabled: () => boolean;
  now?: () => number;
  idleMs?: number;
  exec?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
}

export class SessionSummarizer {
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** Haiku tayyorlagan, lekin yuborilmagan xulosalar (xotirada; qayta yuborishda haiku qayta ishlamaydi). */
  private readonly unsent = new Map<string, SessionSummaryPayload>();
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly d: SummarizerDeps) {
    this.now = d.now ?? Date.now;
    d.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  start(tickMs = 60_000): void {
    this.timer = setInterval(() => void this.scan().catch((err: unknown) => this.d.log.warn('xulosa aylanishi xatosi', { error: errMsg(err) })), tickMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Hook keldi: `SessionEnd` bo'lsa tez orada (holat yozilgach) shu sessiya tekshiriladi. */
  noteHook(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p['hook_event_name'] !== 'SessionEnd' || typeof p['session_id'] !== 'string' || p['agent_id']) return;
    const id = p['session_id'];
    const t = setTimeout(() => void this.enqueue(id).catch(() => undefined), 3000);
    t.unref();
  }

  /** Tinch (10 daqiqa+) ochiq va yaqinda tugagan sessiyalarni ko'rib chiqadi. */
  async scan(): Promise<void> {
    if (this.stopped || !this.d.enabled()) return;
    const t = this.now();
    const idle = this.d.store.listOpen().filter((s) => t - s.lastHookAt >= (this.d.idleMs ?? IDLE_MS) && s.status !== 'working' && s.status !== 'awaiting_approval');
    const ended = this.d.store.listRecentlyEnded(ENDED_WINDOW_MS);
    for (const s of [...ended, ...idle]) await this.enqueue(s.id);
  }

  /** Ketma-ket (bir vaqtda bitta haiku): navbat. */
  enqueue(sessionId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return this.queue;
    this.inFlight.add(sessionId);
    this.queue = this.queue.then(() => this.run(sessionId)).catch((err: unknown) => this.d.log.warn('xulosa xatosi', { error: errMsg(err) })).finally(() => void this.inFlight.delete(sessionId));
    return this.queue;
  }

  private getState(id: string): State | undefined {
    const r = this.d.db.prepare('SELECT v FROM kv WHERE k = ?').get(`sumstate:${id}`) as { v: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.v) as State;
    } catch {
      return undefined;
    }
  }

  private setState(id: string, s: State): void {
    this.d.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(`sumstate:${id}`, JSON.stringify(s));
  }

  private dayKey(): string {
    return `sumday:${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  private dayCount(): number {
    const r = this.d.db.prepare('SELECT v FROM kv WHERE k = ?').get(this.dayKey()) as { v: string } | undefined;
    return r ? Number(r.v) || 0 : 0;
  }

  private bumpDay(): void {
    this.d.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1').run(this.dayKey(), '1');
  }

  private async run(id: string): Promise<void> {
    if (this.stopped || !this.d.enabled()) return;
    const row = this.d.store.get(id);
    if (!row?.transcriptPath) return;
    const trigger: SummaryTrigger = row.endedAt !== null || row.status === 'ended' ? 'ended' : 'idle';
    let size: number;
    try {
      size = (await stat(row.transcriptPath)).size;
    } catch {
      return;
    }
    const st = this.getState(id);
    const t = this.now();
    if (st) {
      if (st.retryAt !== undefined && t < st.retryAt) return;
      if (size < st.size + (trigger === 'ended' ? MIN_GROWTH_ENDED_BYTES : MIN_GROWTH_BYTES) && st.retryAt === undefined) return;
    }
    if (this.dayCount() >= LOCAL_DAILY_MAX) return;

    const pending = this.unsent.get(id);
    if (pending) {
      await this.send(id, row, pending, size);
      return;
    }

    // 1) markaz ruxsati (offline = qaytamiz, hech narsa sarflanmaydi)
    const checkReply = await this.d.mailbox.request(id, { op: 'summary_check' }, CHECK_TIMEOUT_MS);
    if (!checkReply.ok) return;
    const check = SummaryCheckResultSchema.safeParse(checkReply.data);
    if (!check.success) return;
    if (!check.data.allow) {
      const wait = check.data.reason === 'unknown_session' ? 10 * 60_000 : check.data.reason === 'daily_cap' ? 30 * 60_000 : 6 * 3600_000;
      this.setState(id, { size: st?.size ?? 0, at: st?.at ?? 0, retryAt: t + wait });
      return;
    }

    // 2) transcript (lokal) -> qisqartirilgan kirish
    const read = await readTranscriptItems(row.transcriptPath);
    if (!read) return;
    const built = buildSummaryInput(read.items, projectNameOf(row));
    if (built.stats.promptCount < check.data.minPrompts || built.stats.tokens < check.data.minTokens) {
      this.setState(id, { size: read.size, at: t });
      return;
    }

    // 3) haiku (lokal)
    this.bumpDay();
    const out = await runHaiku({ claudeBin: this.d.claudeBin, dir: this.d.dir, system: SESSION_SUMMARY_SYSTEM_PROMPT, prompt: built.prompt, timeoutMs: HAIKU_TIMEOUT_MS, log: this.d.log, label: 'session.summary', ...(this.d.exec ? { exec: this.d.exec } : {}) });
    const parsed = out.ok ? parseSessionSummaryOutput(out.text, redactChatText) : null;
    if (!out.ok || !parsed) {
      const attempts = (st?.attempts ?? 0) + 1;
      this.setState(id, attempts >= MAX_ATTEMPTS ? { size: read.size, at: t } : { size: st?.size ?? 0, at: st?.at ?? 0, attempts, retryAt: t + 15 * 60_000 });
      this.d.log.warn('xulosa yaratilmadi', { reason: out.ok ? 'invalid_output' : out.code, attempts });
      return;
    }
    const payload = SessionSummaryPayloadSchema.safeParse({
      summary: parsed.summary,
      done: parsed.done.map(redact),
      files: parsed.files.map(redact),
      openItems: parsed.open_items.map(redact),
      decisions: parsed.decisions,
      model: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(out.model) ? out.model : 'haiku',
      tokensUsed: Math.min(out.tokens, 10_000_000),
      promptCount: built.stats.promptCount,
      sourceTokens: built.stats.tokens,
      trigger,
    });
    if (!payload.success) {
      this.setState(id, { size: read.size, at: t });
      return;
    }
    await this.send(id, row, payload.data, read.size);
  }

  private async send(id: string, _row: SessionRow, payload: SessionSummaryPayload, size: number): Promise<void> {
    const reply = await this.d.mailbox.request(id, { op: 'session_summary', summary: payload }, SEND_TIMEOUT_MS);
    const t = this.now();
    if (!reply.ok) {
      this.unsent.set(id, payload);
      this.setState(id, { size: this.getState(id)?.size ?? 0, at: this.getState(id)?.at ?? 0, retryAt: t + 2 * 60_000 });
      return;
    }
    this.unsent.delete(id);
    this.setState(id, { size, at: t });
    this.d.log.info('sessiya xulosasi yuborildi', { session: id.slice(0, 8), trigger: payload.trigger, tokens: payload.tokensUsed });
  }
}

function projectNameOf(row: SessionRow): string {
  const p = row.root ?? row.cwd ?? '';
  return basename(p) || 'noma\'lum';
}
