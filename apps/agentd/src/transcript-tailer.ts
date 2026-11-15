import { statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { UsageRecordSchema } from '@commander/contracts';
import type { ErrorLoopEmitter } from './error-loop.js';
import { errMsg, type Logger } from './logger.js';
import type { Outbox } from './outbox.js';
import type { SessionStore } from './session-store.js';
import { groupToUsageRecord, mergeIntoGroup, parseTranscriptLine, type RequestGroup } from './transcript.js';

/** Bitta poll'da ko'pi bilan shuncha bayt o'qiladi (xotira chegarasi). */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** OTel yozuvi kelishi uchun kutish: so'rov yoshi shundan kam bo'lsa transcript yozuvi chiqarilmaydi (PLAN §6.2: 2 daqiqa). */
export const OTEL_GRACE_MS = 2 * 60 * 1000;
/** Guruhga oxirgi yozuv qo'shilganidan shuncha o'tgach guruh "tugagan" hisoblanadi. */
export const SETTLE_MS = 3000;
/** Tugagan sessiya transcript'i shuncha vaqt kuzatiladi (kutayotgan guruhlar chiqishi uchun). */
const TAIL_AFTER_END_MS = OTEL_GRACE_MS + 5 * 60 * 1000;

interface Tracked {
  sessionId: string;
  path: string;
  groups: Map<string, RequestGroup>;
  /** Xotiradagi o'qish kursori (saqlangan offset kutayotgan guruh boshiga qaytishi mumkin, kursor esa oldinga yuradi). */
  cursor?: number;
}

/**
 * Fallback token manbai (PLAN §6.2): transcript JSONL'ni offset bilan kuzatadi (offset SQLite'da saqlanadi).
 * Qaror qoidasi: so'rov yozuvi faqat `OTEL_GRACE_MS` o'tgach va OTel'dan o'sha `requestId` kelmagan bo'lsa
 * `source: 'transcript'` bilan chiqariladi. Shu sababli OTel ishlayotgan sessiyada dublikat chiqmaydi (OTel `requestId`
 * allaqachon `usage_seen`da), OTel yo'q sessiyada token 2 daqiqa kechikib bo'lsa ham yo'qolmaydi.
 * `ts` = guruhdagi birinchi yozuvning vaqti (barqaror). Yangi (hali offsetsiz) fayl EOF'dan boshlanadi: tarix qayta sanalmaydi.
 */
export class TranscriptTailer {
  private readonly tracked = new Map<string, Tracked>(); // path -> state
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly store: SessionStore,
    private readonly outbox: Outbox,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly onEnqueued: () => void = () => undefined,
    /** 3.2: bir xil tool xatosi takrorini aniqlaydi (matn saqlanmaydi, faqat xesh). */
    private readonly errorLoop?: ErrorLoopEmitter,
  ) {}

  start(intervalMs = 5000): void {
    this.refreshTracked();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Hook'dan yangi transcript yo'li kelganda chaqiriladi. */
  register(sessionId: string, path: string): void {
    if (this.tracked.has(path)) return;
    this.tracked.set(path, { sessionId, path, groups: new Map() });
    this.initOffset(sessionId, path);
  }

  /** Offset hali yo'q bo'lsa: mavjud fayl EOF'dan (tarix qayta sanalmaydi), hali yo'q fayl boshidan boshlanadi. */
  private initOffset(sessionId: string, path: string): void {
    if (this.store.getOffset(path) !== undefined) return;
    let start = 0;
    try {
      start = statSync(path).size;
    } catch {
      start = 0;
    }
    this.store.setOffset(path, sessionId, start);
  }

  /** Test va taymer uchun: bitta aylanish. */
  async pollOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.refreshTracked();
      for (const t of this.tracked.values()) {
        try {
          await this.pollFile(t);
        } catch (err) {
          this.log.warn('transcript o\'qishda xato', { sessionId: t.sessionId, error: errMsg(err) });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  private refreshTracked(): void {
    const wanted = new Map<string, string>();
    for (const s of this.store.listOpen()) if (s.transcriptPath) wanted.set(s.transcriptPath, s.id);
    for (const s of this.store.listRecentlyEnded(TAIL_AFTER_END_MS)) if (s.transcriptPath) wanted.set(s.transcriptPath, s.id);
    for (const [path, id] of wanted) {
      if (!this.tracked.has(path)) {
        this.tracked.set(path, { sessionId: id, path, groups: new Map() });
        this.initOffset(id, path);
      }
    }
    for (const path of [...this.tracked.keys()]) if (!wanted.has(path) && this.tracked.get(path)?.groups.size === 0) this.tracked.delete(path);
  }

  private async pollFile(t: Tracked): Promise<void> {
    let offset = t.cursor ?? this.store.getOffset(t.path) ?? 0;
    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      return; // fayl hali yo'q yoki o'chirilgan
    }
    if (size < offset) offset = 0; // fayl qisqardi (rotatsiya): boshidan
    const nowMs = this.now();

    let consumedTo = offset;
    if (size > offset) {
      const want = Math.min(size - offset, MAX_READ_BYTES);
      const fh = await open(t.path, 'r');
      let buf: Buffer;
      try {
        buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, offset);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      let lineStart = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, lineStart);
        if (nl === -1) break; // oxirgi to'liq bo'lmagan qator: keyingi poll
        const text = buf.toString('utf8', lineStart, nl);
        this.errorLoop?.feed(t.sessionId, text, nowMs);
        const entry = parseTranscriptLine(text);
        if (entry) mergeIntoGroup(t.groups, entry, offset + lineStart, nowMs);
        lineStart = nl + 1;
      }
      consumedTo = offset + lineStart;
    }

    t.cursor = consumedTo;
    this.flushGroups(t, nowMs);

    // Kutayotgan guruhlar bo'lsa offset eng birinchisining boshiga qo'yiladi (restartdan keyin qayta o'qiladi; dedup xavfsiz).
    let persist = consumedTo;
    for (const g of t.groups.values()) persist = Math.min(persist, g.startOffset);
    this.store.setOffset(t.path, t.sessionId, persist);
  }

  private flushGroups(t: Tracked, nowMs: number): void {
    let emitted = 0;
    const session = this.store.get(t.sessionId);
    const cwd = session?.root ?? session?.cwd ?? undefined;
    for (const [requestId, g] of t.groups) {
      if (this.outbox.hasSeenUsage(requestId)) {
        t.groups.delete(requestId); // OTel (yoki oldingi poll) allaqachon yetkazgan
        continue;
      }
      if (nowMs - g.lastSeenAt < SETTLE_MS) continue; // so'rov hali yozilmoqda
      if (nowMs - g.ts < OTEL_GRACE_MS) continue; // OTel kelishi mumkin
      const record = groupToUsageRecord(g, t.sessionId, cwd);
      const checked = UsageRecordSchema.safeParse(record);
      if (!checked.success) {
        this.log.warn('transcript usage yozuvi kontraktga mos emas, tashlandi', { requestId });
        this.outbox.markUsageSeen(requestId);
      } else if (this.outbox.enqueueUsage(checked.data)) {
        emitted++;
      }
      t.groups.delete(requestId);
    }
    if (emitted > 0) {
      this.log.info('transcript fallback usage chiqarildi', { sessionId: t.sessionId, count: emitted });
      this.onEnqueued();
    }
  }
}
