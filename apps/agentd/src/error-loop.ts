import { createHash, randomUUID } from 'node:crypto';
import { ERROR_LOOP_AGENT_THRESHOLD, ERROR_LOOP_EVENT, ERROR_LOOP_NOTIFICATION, formatErrorLoopMessage } from '@commander/contracts';
import type { AgentEvent } from '@commander/contracts';
import type { Outbox } from './outbox.js';
import type { SessionStore } from './session-store.js';

/**
 * Xato-takrori detektori (3.2). Transcript'dagi `tool_result` (`is_error: true`) xatolarini kuzatadi va bir xil xato
 * 10 daqiqada `ERROR_LOOP_AGENT_THRESHOLD` (5) martaga yetganda `agent.events` ga `ErrorLoop` belgisi chiqaradi.
 *
 * MAXFIYLIK (CLAUDE.md #5): xato MATNI hech qachon saqlanmaydi va yuborilmaydi: faqat normallashtirilgan matnning qisqa SHA-256
 * xeshi (raqamlar/uzun hex/yo'llar "#" ga almashtiriladi: bir xil xato turli vaqt/pid bilan bir xil xesh beradi) va hisoblagich.
 * Belgi sessiya holatini o'zgartirmaydi (status = joriy holat); markaz uni `message` dan `error_loop:<xesh>:<son>` sifatida o'qiydi.
 */

export const ERROR_LOOP_WINDOW_MS = 10 * 60_000;
const MAX_HASHES_PER_SESSION = 50;
const MAX_SESSIONS = 200;
const MAX_NORMALIZED_CHARS = 400;

/** Xatoni barqaror qisqa xeshga aylantiradi (matn qaytmaydi). */
export function hashErrorText(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][\w.\-\\/@~]+/g, '#path')
    .replace(/\b[0-9a-f]{8,}\b/g, '#hex')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NORMALIZED_CHARS);
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

/** Transcript qatoridan `tool_result` xatosining xeshi; xato bo'lmasa (yoki yaroqsiz qator) null. Tez filtr: parse'dan oldin. */
export function toolErrorHashFromLine(line: string): string | null {
  if (line.length === 0 || !line.includes('"tool_result"') || !line.includes('"is_error"')) return null;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const content = (json as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as { type?: unknown; is_error?: unknown; content?: unknown };
    if (it.type !== 'tool_result' || it.is_error !== true) continue;
    const c = it.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join(' ') : '';
    return hashErrorText(text);
  }
  return null;
}

/** Sof hisoblagich: `record` chegaraga yetganda (va keyin har chegara karrasida) `{hash, count}` qaytaradi. */
export class ErrorLoopTracker {
  private readonly sessions = new Map<string, Map<string, number[]>>();

  constructor(
    private readonly threshold: number = ERROR_LOOP_AGENT_THRESHOLD,
    private readonly windowMs: number = ERROR_LOOP_WINDOW_MS,
  ) {}

  record(sessionId: string, hash: string, at: number): { hash: string; count: number } | null {
    let per = this.sessions.get(sessionId);
    if (!per) {
      if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
      per = new Map();
      this.sessions.set(sessionId, per);
    }
    const stamps = (per.get(hash) ?? []).filter((t) => at - t < this.windowMs);
    stamps.push(at);
    per.delete(hash);
    per.set(hash, stamps);
    if (per.size > MAX_HASHES_PER_SESSION) per.delete(per.keys().next().value as string);
    return stamps.length >= this.threshold && stamps.length % this.threshold === 0 ? { hash, count: stamps.length } : null;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Transcript qatorini kuzatadi va chegaraga yetganda outbox'ga `ErrorLoop` hodisasini qo'yadi. */
export class ErrorLoopEmitter {
  constructor(
    private readonly store: SessionStore,
    private readonly outbox: Outbox,
    private readonly onEnqueued: () => void = () => undefined,
    private readonly tracker: ErrorLoopTracker = new ErrorLoopTracker(),
  ) {}

  feed(sessionId: string, line: string, nowMs: number): boolean {
    const hash = toolErrorHashFromLine(line);
    if (hash === null) return false;
    const hit = this.tracker.record(sessionId, hash, nowMs);
    if (!hit) return false;
    const session = this.store.get(sessionId);
    const cwd = session?.root ?? session?.cwd;
    if (!session || !cwd || session.status === 'ended') return false;
    const event: AgentEvent = {
      eventId: randomUUID(),
      claudeSessionId: sessionId,
      event: ERROR_LOOP_EVENT,
      status: session.status ?? 'working',
      cwd,
      message: formatErrorLoopMessage(hit.hash, hit.count),
      notificationType: ERROR_LOOP_NOTIFICATION,
      ts: nowMs,
    };
    const added = this.outbox.enqueueEvent(event);
    if (added) this.onEnqueued();
    return added;
  }
}
