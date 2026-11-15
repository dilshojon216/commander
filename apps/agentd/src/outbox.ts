import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, AgentLimitsPayload, ProjectSnapshotPayload, UsageRecord } from '@commander/contracts';
import { inTransaction } from './db.js';
import type { Logger } from './logger.js';

export type OutboxType = 'events' | 'usage' | 'limits' | 'projects';

export interface OutboxCaps {
  /** Har tur uchun qatorlar soni chegarasi (oshsa eng eskilari tashlanadi, ogohlantirish bilan). */
  maxRows: Record<OutboxType, number>;
  /** Usage yozuvlari shu kundan eskisi tashlanadi. */
  usageMaxAgeDays: number;
}

export const DEFAULT_CAPS: OutboxCaps = {
  maxRows: { events: 50_000, usage: 100_000, limits: 200, projects: 500 },
  usageMaxAgeDays: 7,
};

export interface OutboxRow<T> {
  seq: number;
  item: T;
  size: number;
  attempts: number;
}

export interface BatchLimits {
  maxItems: number;
  /** Batch ichidagi elementlarning JSON hajmi yig'indisi chegarasi (bayt). */
  maxBytes: number;
}

interface RawRow {
  seq: number;
  item: string;
  size: number;
  attempts: number;
  next_attempt_at: number;
}

const USAGE_SEEN_RETENTION_MS = 14 * 24 * 3600 * 1000;

/**
 * Chidamli (SQLite) navbat. Xabarlar center `ack` bergunicha qoladi. Tartib har tur ichida `seq` bo'yicha;
 * `nextBatch` faqat ketma-ket BOSHidan oladi (boshi retry kutayotgan bo'lsa hech narsa qaytarmaydi), shuning
 * uchun hodisalar tartibi buzilmaydi.
 */
export class Outbox {
  private enqueuedSincePrune = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly log: Logger,
    private readonly caps: OutboxCaps = DEFAULT_CAPS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Hodisa (eventId bo'yicha unikal). `true` = yangi qo'shildi. */
  enqueueEvent(event: AgentEvent): boolean {
    return this.insert('events', event.eventId, event, event.ts);
  }

  /**
   * Usage yozuvi `requestId` bo'yicha lokal dedup (ack'dan keyin ham: `usage_seen`). `true` = yangi.
   */
  enqueueUsage(record: UsageRecord): boolean {
    return inTransaction(this.db, () => {
      const r = this.db.prepare('INSERT OR IGNORE INTO usage_seen (request_id, seen_at) VALUES (?, ?)').run(record.requestId, this.now());
      if (Number(r.changes) === 0) return false;
      return this.insert('usage', record.requestId, record, record.ts);
    });
  }

  enqueueLimits(limits: AgentLimitsPayload): boolean {
    return this.insert('limits', String(limits.observedAt), limits, limits.observedAt);
  }

  /** Loyiha snapshoti (`path|hash` bo'yicha unikal: bir xil mazmun ikki marta navbatga tushmaydi). `true` = yangi. */
  enqueueProject(snapshot: ProjectSnapshotPayload): boolean {
    return this.insert('projects', `${snapshot.path}|${snapshot.hash}`, snapshot, snapshot.takenAt);
  }

  hasSeenUsage(requestId: string): boolean {
    return this.db.prepare('SELECT 1 FROM usage_seen WHERE request_id = ?').get(requestId) !== undefined;
  }

  /** Transcript/OTel dedup: so'rov manbadan qat'i nazar "ko'rilgan" deb belgilanadi (yuborilmasdan). */
  markUsageSeen(requestId: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO usage_seen (request_id, seen_at) VALUES (?, ?)').run(requestId, this.now());
    return Number(r.changes) > 0;
  }

  nextBatch<T>(type: OutboxType, limits: BatchLimits): Array<OutboxRow<T>> {
    const rows = this.db
      .prepare('SELECT seq, item, size, attempts, next_attempt_at FROM outbox WHERE type = ? ORDER BY seq ASC LIMIT ?')
      .all(type, limits.maxItems) as unknown as RawRow[];
    const out: Array<OutboxRow<T>> = [];
    const t = this.now();
    let bytes = 0;
    for (const row of rows) {
      if (row.next_attempt_at > t) break; // boshi/ketma-ketlik retry kutmoqda: tartibni buzmaymiz
      if (out.length > 0 && bytes + row.size > limits.maxBytes) break;
      bytes += row.size;
      out.push({ seq: row.seq, item: JSON.parse(row.item) as T, size: row.size, attempts: row.attempts });
    }
    return out;
  }

  /** Eng yaqin retry vaqti (ms) yoki `null` (kutayotgani yo'q). Pump taymeri uchun. */
  nextRetryAt(type: OutboxType): number | null {
    const row = this.db.prepare('SELECT next_attempt_at FROM outbox WHERE type = ? ORDER BY seq ASC LIMIT 1').get(type) as
      | { next_attempt_at: number }
      | undefined;
    return row && row.next_attempt_at > this.now() ? row.next_attempt_at : null;
  }

  ack(seqs: number[]): void {
    this.deleteSeqs(seqs);
  }

  /** Non-retriable nack: ma'lumot yo'qotiladi, shuning uchun chaqiruvchi log yozadi. */
  drop(seqs: number[]): void {
    this.deleteSeqs(seqs);
  }

  retryAt(seqs: number[], atMs: number): void {
    if (seqs.length === 0) return;
    inTransaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE seq = ?');
      for (const s of seqs) stmt.run(atMs, s);
    });
  }

  /** Ulanish tiklangach barcha retry kutishlarini bekor qiladi (yangi ulanishda darhol yuborish). */
  clearRetryDelays(): void {
    this.db.exec('UPDATE outbox SET next_attempt_at = 0 WHERE next_attempt_at > 0');
  }

  counts(): Record<OutboxType, number> {
    const rows = this.db.prepare('SELECT type, COUNT(*) AS n FROM outbox GROUP BY type').all() as unknown as Array<{ type: OutboxType; n: number }>;
    const out: Record<OutboxType, number> = { events: 0, usage: 0, limits: 0, projects: 0 };
    for (const r of rows) out[r.type] = Number(r.n);
    return out;
  }

  /** Hajm cheklovlari: eskirgan usage va qatorlar soni chegarasi. Qaytadi: tashlangan qatorlar soni. */
  prune(): number {
    let dropped = 0;
    const cutoff = this.now() - this.caps.usageMaxAgeDays * 24 * 3600 * 1000;
    const old = this.db.prepare("DELETE FROM outbox WHERE type = 'usage' AND ts < ?").run(cutoff);
    if (Number(old.changes) > 0) {
      dropped += Number(old.changes);
      this.log.warn("eskirgan usage yozuvlari outbox'dan tashlandi", { count: Number(old.changes), olderThanDays: this.caps.usageMaxAgeDays });
    }
    for (const type of ['events', 'usage', 'limits', 'projects'] as const) {
      const max = this.caps.maxRows[type];
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE type = ?').get(type) as { n: number }).n);
      if (total > max) {
        const excess = total - max;
        this.db
          .prepare('DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox WHERE type = ? ORDER BY seq ASC LIMIT ?)')
          .run(type, excess);
        dropped += excess;
        this.log.warn("outbox to'ldi: eng eski yozuvlar tashlandi", { type, count: excess, max });
      }
    }
    this.db.prepare('DELETE FROM usage_seen WHERE seen_at < ?').run(this.now() - USAGE_SEEN_RETENTION_MS);
    return dropped;
  }

  private insert(type: OutboxType, key: string, item: unknown, ts: number): boolean {
    const json = JSON.stringify(item);
    const r = this.db
      .prepare('INSERT OR IGNORE INTO outbox (type, dedup_key, item, size, ts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(type, key, json, Buffer.byteLength(json), ts, this.now());
    if (++this.enqueuedSincePrune >= 500) {
      this.enqueuedSincePrune = 0;
      this.prune();
    }
    return Number(r.changes) > 0;
  }

  private deleteSeqs(seqs: number[]): void {
    if (seqs.length === 0) return;
    inTransaction(this.db, () => {
      const stmt = this.db.prepare('DELETE FROM outbox WHERE seq = ?');
      for (const s of seqs) stmt.run(s);
    });
  }
}
