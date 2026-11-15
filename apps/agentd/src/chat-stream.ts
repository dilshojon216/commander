import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { CHAT_LIMITS } from '@commander/contracts';
import type { ChatErrorCode, ChatItem, ChatStreamPagePayload, ChatStreamStartPayload } from '@commander/contracts';
import { ChatItemConverter } from './chat-items.js';
import { resolveTranscript } from './chat-path.js';
import { decodeCursor, readForward, readPage } from './chat-reader.js';
import { errMsg } from './logger.js';
import type { Logger } from './logger.js';

/**
 * Transcript oqimlari (center `chat.stream.*` so'rovlari). Har oqim: yo'lni tekshiradi, oxirgi N elementni (backfill)
 * yuboradi, keyin `fs.watch` + davriy poll bilan offsetdan jonli elementlar. Markaz uzilsa yoki `stop` kelsa to'xtaydi.
 *
 * MAXFIYLIK: hech qachon matn logga yozilmaydi (faqat streamId prefiksi, sonlar va xato kodi). Diskka hech narsa yozilmaydi.
 * Hamma matn `ChatItemConverter` ichida redakt qilinadi va kesiladi.
 */

export interface ChatTransport {
  isReady(): boolean;
  /** Xabarni yuboradi; ulanish yo'q bo'lsa `false`. */
  send(type: 'chat.items' | 'chat.error', payload: unknown): boolean;
}

export interface ChatStreamOptions {
  log: Logger;
  /** `~/.claude/projects` (yoki `CLAUDE_CONFIG_DIR/projects`). */
  projectsRoot: () => string;
  maxStreams?: number;
  /** Fayl o'zgarishini tekshirish oralig'i (fs.watch zaxirasi). */
  pollMs?: number;
  /** Jonli elementlarni yig'ish oynasi. */
  flushMs?: number;
  /** Chat xabarlari orasidagi eng kichik oraliq (center: 600 xabar/daqiqa, hammasi uchun). */
  minSendGapMs?: number;
}

interface Stream {
  id: string;
  claudeSessionId: string;
  includeThinking: boolean;
  path: string;
  conv: ChatItemConverter;
  offset: number;
  pending: ChatItem[];
  reading: boolean;
  dirty: boolean;
  stopped: boolean;
  watcher: FSWatcher | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  flushTimer: NodeJS.Timeout | undefined;
}

const MAX_PENDING_ITEMS = 2000;

/** Elementlarni xabar chegaralariga (<=100 element, <=~160 KiB) ajratadi. */
export function chunkItems(items: ChatItem[], maxItems: number = CHAT_LIMITS.maxItemsPerMessage, maxBytes: number = CHAT_LIMITS.targetMessageBytes): ChatItem[][] {
  const chunks: ChatItem[][] = [];
  let cur: ChatItem[] = [];
  let bytes = 0;
  for (const it of items) {
    const size = Buffer.byteLength(JSON.stringify(it), 'utf8');
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export class ChatStreamManager {
  private readonly streams = new Map<string, Stream>();
  private readonly starting = new Set<string>();
  /** `start` davomida kelgan `stop`: oqim yaratilmaydi. */
  private readonly cancelled = new Set<string>();
  private readonly maxStreams: number;
  private readonly pollMs: number;
  private readonly flushMs: number;
  private readonly gapMs: number;
  private sendQueue: Array<{ type: 'chat.items' | 'chat.error'; payload: unknown; streamId: string }> = [];
  private sendTimer: NodeJS.Timeout | undefined;
  private lastSendAt = 0;
  private stoppedAll = false;

  constructor(
    private readonly transport: ChatTransport,
    private readonly o: ChatStreamOptions,
  ) {
    this.maxStreams = o.maxStreams ?? CHAT_LIMITS.maxStreamsPerAgent;
    this.pollMs = o.pollMs ?? 1500;
    this.flushMs = o.flushMs ?? 250;
    this.gapMs = o.minSendGapMs ?? 200;
  }

  count(): number {
    return this.streams.size;
  }

  // --- center so'rovlari ---

  /** `chat.stream.start`. Mavjud `streamId` uchun qayta chaqirish = resync (backfill `replace` bilan qayta). */
  async onStart(p: ChatStreamStartPayload): Promise<void> {
    this.stoppedAll = false;
    const existing = this.streams.get(p.streamId);
    if (!existing && (this.streams.size + this.starting.size >= this.maxStreams || this.starting.has(p.streamId))) {
      this.emitError(p.streamId, 'busy');
      return;
    }
    if (!existing) this.starting.add(p.streamId);
    try {
      const resolved = await resolveTranscript({ root: this.o.projectsRoot(), claudeSessionId: p.claudeSessionId, hint: p.transcriptPath });
      if (!resolved.ok) {
        this.emitError(p.streamId, resolved.code);
        return;
      }
      if (this.stoppedAll || this.cancelled.has(p.streamId)) return; // start paytida markaz uzildi yoki stop keldi
      const stream = existing ?? this.create(p, resolved.path);
      await this.backfill(stream, p.tail);
      if (!existing && !stream.stopped) this.watch(stream);
    } catch (err) {
      this.o.log.warn('chat oqimini boshlashda xato', { stream: short(p.streamId), error: errMsg(err) });
      this.emitError(p.streamId, 'read_failed');
      this.drop(p.streamId);
    } finally {
      this.starting.delete(p.streamId);
      this.cancelled.delete(p.streamId);
    }
  }

  onStop(streamId: string): void {
    if (this.starting.has(streamId)) this.cancelled.add(streamId);
    this.drop(streamId);
  }

  /** `chat.stream.page`: eski sahifa (faqat shu so'rovchiga: `pageId`). */
  async onPage(p: ChatStreamPagePayload): Promise<void> {
    const s = this.streams.get(p.streamId);
    if (!s) {
      this.emitError(p.streamId, 'not_found', p.pageId);
      return;
    }
    const before = decodeCursor(p.before);
    if (before === undefined) {
      this.emitError(p.streamId, 'internal', p.pageId);
      return;
    }
    try {
      const conv = new ChatItemConverter({ includeThinking: s.includeThinking });
      const page = await readPage(s.path, conv, p.limit, before);
      this.sendItems(s.id, page.items, { older: true, cursor: page.cursor, pageId: p.pageId, done: true });
    } catch (err) {
      this.o.log.warn('chat sahifasini o\'qishda xato', { stream: short(p.streamId), error: errMsg(err) });
      this.emitError(p.streamId, 'read_failed', p.pageId);
    }
  }

  /** WS uzildi / agentd to'xtadi: hamma oqim yopiladi (markaz qayta ulangach o'zi qayta so'raydi). */
  stopAll(): void {
    this.stoppedAll = true;
    for (const id of [...this.streams.keys()]) this.drop(id);
    this.sendQueue = [];
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
  }

  // --- ichki ---

  private create(p: ChatStreamStartPayload, path: string): Stream {
    const s: Stream = {
      id: p.streamId,
      claudeSessionId: p.claudeSessionId,
      includeThinking: p.includeThinking === true,
      path,
      conv: new ChatItemConverter({ includeThinking: p.includeThinking === true }),
      offset: 0,
      pending: [],
      reading: false,
      dirty: false,
      stopped: false,
      watcher: undefined,
      pollTimer: undefined,
      flushTimer: undefined,
    };
    this.streams.set(s.id, s);
    return s;
  }

  private async backfill(s: Stream, tail: number): Promise<void> {
    s.conv = new ChatItemConverter({ includeThinking: s.includeThinking });
    s.pending = [];
    const page = await readPage(s.path, s.conv, tail);
    s.offset = page.size; // jonli kuzatuv shu offsetdan (oxirgi to'liq qatordan) boshlanadi
    this.sendItems(s.id, page.items, { replace: true, cursor: page.cursor, done: true });
  }

  private watch(s: Stream): void {
    try {
      s.watcher = watch(s.path, { persistent: false }, () => this.schedulePump(s));
      s.watcher.on('error', () => {
        s.watcher?.close();
        s.watcher = undefined; // poll davom etadi
      });
    } catch {
      s.watcher = undefined;
    }
    s.pollTimer = setInterval(() => this.schedulePump(s), this.pollMs);
    s.pollTimer.unref();
  }

  private schedulePump(s: Stream): void {
    if (s.stopped) return;
    if (s.reading) {
      s.dirty = true;
      return;
    }
    void this.pump(s);
  }

  private async pump(s: Stream): Promise<void> {
    s.reading = true;
    try {
      do {
        s.dirty = false;
        const r = await readForward(s.path, s.conv, s.offset);
        if (s.stopped) return;
        if (r.truncated) {
          // Fayl qisqardi (rotatsiya/rewind): hozirgi holatni qayta yuboramiz
          await this.backfill(s, CHAT_LIMITS.defaultTail);
          continue;
        }
        s.offset = r.offset;
        const rids = new Set<string>();
        for (const e of r.entries) {
          s.pending.push(...e.items);
          for (const id of e.requestIds) rids.add(id);
        }
        if (rids.size > 0) s.pending.push(...s.conv.usageItems(rids));
        if (s.pending.length > MAX_PENDING_ITEMS) s.pending.splice(0, s.pending.length - MAX_PENDING_ITEMS);
        if (s.pending.length > 0) this.scheduleFlush(s);
      } while (s.dirty && !s.stopped);
    } catch (err) {
      // Vaqtinchalik (fayl o'chirildi/ruxsat): keyingi poll qayta uradi; matn logga tushmaydi
      this.o.log.debug('chat oqimi o\'qish xatosi', { stream: short(s.id), error: errMsg(err) });
    } finally {
      s.reading = false;
    }
  }

  private scheduleFlush(s: Stream): void {
    if (s.flushTimer || s.stopped) return;
    s.flushTimer = setTimeout(() => {
      s.flushTimer = undefined;
      if (s.stopped || s.pending.length === 0) return;
      const items = dedupeById(s.pending);
      s.pending = [];
      this.sendItems(s.id, items, {});
    }, this.flushMs);
    s.flushTimer.unref();
  }

  private drop(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    s.stopped = true;
    s.watcher?.close();
    if (s.pollTimer) clearInterval(s.pollTimer);
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.pending = [];
    this.streams.delete(streamId);
    this.sendQueue = this.sendQueue.filter((m) => m.streamId !== streamId);
  }

  // --- yuborish (sekinlashtirilgan navbat) ---

  private sendItems(streamId: string, items: ChatItem[], extra: { replace?: boolean; older?: boolean; cursor?: string | null; pageId?: string; done?: boolean }): void {
    const chunks = chunkItems(items);
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((chunk, i) => {
      const last = i === chunks.length - 1;
      this.enqueue('chat.items', streamId, {
        streamId,
        items: chunk,
        ...(extra.pageId ? { pageId: extra.pageId } : {}),
        ...(extra.replace && i === 0 ? { replace: true } : {}),
        ...(extra.older ? { older: true } : {}),
        ...(extra.cursor !== undefined ? { cursor: extra.cursor } : {}),
        ...(extra.done && last ? { done: true } : {}),
      });
    });
  }

  private emitError(streamId: string, code: ChatErrorCode, pageId?: string): void {
    this.enqueue('chat.error', streamId, { streamId, code, ...(pageId ? { pageId } : {}) });
  }

  private enqueue(type: 'chat.items' | 'chat.error', streamId: string, payload: unknown): void {
    this.sendQueue.push({ type, payload, streamId });
    this.drain();
  }

  private drain(): void {
    if (this.sendTimer || this.sendQueue.length === 0) return;
    const wait = this.lastSendAt + this.gapMs - Date.now();
    if (wait > 0) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = undefined;
        this.drain();
      }, wait);
      this.sendTimer.unref();
      return;
    }
    const m = this.sendQueue.shift()!;
    this.lastSendAt = Date.now();
    if (!this.transport.isReady() || !this.transport.send(m.type, m.payload)) {
      this.sendQueue = []; // aloqa yo'q: navbat eskirgan (markaz qayta ulangach qayta so'raydi)
      return;
    }
    this.drain();
  }
}

const short = (id: string): string => id.slice(0, 8);

/** Bir xil `id` li elementlardan oxirgisi qoladi (usage yangilanishlari) va tartib saqlanadi. */
export function dedupeById(items: ChatItem[]): ChatItem[] {
  const last = new Map<string, number>();
  items.forEach((it, i) => last.set(it.id, i));
  return items.filter((it, i) => last.get(it.id) === i);
}
