import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import type { AuditRecord } from './audit.service.js';

interface Bucket {
  record: AuditRecord;
  /** Hali yozilmagan (bostirilgan) hodisalar soni. */
  pending: number;
  lastWriteAt: number;
  lastSeenAt: number;
}

export interface AggregatorOptions {
  /** Bir kalit uchun ikki yozuv orasidagi minimal vaqt. */
  windowMs: number;
  /** Bir oynada barcha kalitlar bo'yicha yoziladigan maksimal qatorlar. */
  maxRowsPerWindow: number;
  maxKeys: number;
}

export const DEFAULT_AGGREGATOR_OPTIONS: AggregatorOptions = { windowMs: 60_000, maxRowsPerWindow: 20, maxKeys: 500 };

const OVERFLOW_KEY = '__overflow__';

/**
 * Takrorlanuvchi muvaffaqiyatsizliklar (auth xatolari, noto'g'ri kodlar) uchun audit "to'fon" himoyasi.
 * Har kalit (turi|sabab|IP) uchun birinchi hodisa darhol yoziladi, keyingilari oyna davomida sanaladi
 * va oyna oxirida BITTA qator (`details.count`) bo'lib yoziladi. Barcha kalitlar bo'yicha oynada
 * `maxRowsPerWindow` dan ortiq qator yozilmaydi: ortig'i bitta `overflow` yozuvga yig'iladi.
 * Eng yomon holat: ~maxRowsPerWindow+1 qator/daqiqa, hujum qancha kuchli bo'lmasin.
 */
@Injectable()
export class FailureAggregator implements OnModuleDestroy {
  private readonly logger = new Logger(FailureAggregator.name);
  private readonly buckets = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private windowStart = 0;
  private rowsThisWindow = 0;
  private opts: AggregatorOptions = DEFAULT_AGGREGATOR_OPTIONS;

  constructor(private readonly audit: AuditService) {}

  configure(opts: Partial<AggregatorOptions>): void {
    this.opts = { ...DEFAULT_AGGREGATOR_OPTIONS, ...opts };
  }

  /** Muvaffaqiyatsiz hodisani qayd etadi (hech qachon exception tashlamaydi). */
  note(key: string, record: AuditRecord, now: number = Date.now()): void {
    this.ensureTimer();
    this.rollWindow(now);
    let bucketKey = key;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket && this.buckets.size >= this.opts.maxKeys) {
      bucketKey = OVERFLOW_KEY;
      bucket = this.buckets.get(bucketKey);
    }
    if (!bucket) {
      bucket = { record, pending: 0, lastWriteAt: Number.NEGATIVE_INFINITY, lastSeenAt: now };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.lastSeenAt = now;
    bucket.pending += 1;
    if (bucketKey === OVERFLOW_KEY) bucket.record = { actorKind: 'system', action: 'audit.overflow', details: {} };
    if (now - bucket.lastWriteAt >= this.opts.windowMs) this.writeBucket(bucketKey, bucket, now);
  }

  private rollWindow(now: number): void {
    if (now - this.windowStart >= this.opts.windowMs) {
      this.windowStart = now;
      this.rowsThisWindow = 0;
    }
  }

  private writeBucket(key: string, bucket: Bucket, now: number): void {
    if (bucket.pending === 0) return;
    if (key !== OVERFLOW_KEY && this.rowsThisWindow >= this.opts.maxRowsPerWindow) {
      // Cheklovga yetdi: hodisalarni overflow kovagiga ko'chiramiz.
      let overflow = this.buckets.get(OVERFLOW_KEY);
      if (!overflow) {
        overflow = { record: { actorKind: 'system', action: 'audit.overflow', details: {} }, pending: 0, lastWriteAt: Number.NEGATIVE_INFINITY, lastSeenAt: now };
        this.buckets.set(OVERFLOW_KEY, overflow);
      }
      overflow.pending += bucket.pending;
      overflow.lastSeenAt = now;
      bucket.pending = 0;
      bucket.lastWriteAt = now;
      if (now - overflow.lastWriteAt >= this.opts.windowMs) this.writeBucket(OVERFLOW_KEY, overflow, now);
      return;
    }
    const count = bucket.pending;
    bucket.pending = 0;
    bucket.lastWriteAt = now;
    this.rowsThisWindow += 1;
    const record: AuditRecord = {
      ...bucket.record,
      details: { ...(bucket.record.details ?? {}), count, window_seconds: Math.round(this.opts.windowMs / 1000) },
    };
    const write: Promise<void> = this.audit
      .record(record)
      .catch((err: unknown) => {
        this.logger.error(`Failed to write aggregated audit row ${record.action}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.inflight.delete(write));
    this.inflight.add(write);
  }

  /** Oyna tugagan, lekin yozilmagan sanoqlarni yozadi; eskirgan kovaklarni tozalaydi. */
  flush(now: number = Date.now(), force = false): void {
    this.rollWindow(now);
    for (const [key, bucket] of this.buckets) {
      if (bucket.pending > 0 && (force || now - bucket.lastWriteAt >= this.opts.windowMs)) {
        this.writeBucket(key, bucket, now);
      }
      if (bucket.pending === 0 && now - bucket.lastSeenAt > this.opts.windowMs * 2) this.buckets.delete(key);
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.opts.windowMs);
    this.timer.unref();
  }

  /** To'xtashda kutilayotgan sanoqlarni yozadi va DB yopilishidan oldin yozuvlarni kutadi. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(Date.now(), true);
    await Promise.allSettled([...this.inflight]);
  }
}
