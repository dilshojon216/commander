import type { UsageRecord } from '@commander/contracts';
import { UsageRecordSchema } from '@commander/contracts';
import type { Logger } from './logger.js';
import type { ParsedApiRequest } from './otlp.js';
import type { Outbox } from './outbox.js';
import type { SessionStore } from './session-store.js';

/**
 * OTel api_request -> UsageRecord -> outbox. `cwd` OTel'da yo'q: sessiya jadvalidan (hook'lar bergan loyiha ildizi),
 * shu bilan hodisalar va usage BIR XIL ildizdan foydalanadi. Sessiya noma'lum bo'lsa `cwd` yuborilmaydi.
 */
export class UsageIngest {
  constructor(
    private readonly store: SessionStore,
    private readonly outbox: Outbox,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly onEnqueued: () => void = () => undefined,
  ) {}

  ingestOtel(requests: ParsedApiRequest[]): { accepted: number; duplicates: number } {
    let accepted = 0;
    let duplicates = 0;
    for (const { record } of requests) {
      const session = this.store.get(record.claudeSessionId);
      const cwd = session?.root ?? session?.cwd ?? undefined;
      const full: UsageRecord = { ...record, ...(cwd ? { cwd } : {}) };
      const checked = UsageRecordSchema.safeParse(full);
      if (!checked.success) {
        this.log.warn("OTel usage yozuvi kontraktga mos emas, tashlandi", { requestId: record.requestId });
        continue;
      }
      this.store.markOtel(record.claudeSessionId, this.now());
      if (this.outbox.enqueueUsage(checked.data)) accepted++;
      else duplicates++;
    }
    if (accepted > 0) this.onEnqueued();
    return { accepted, duplicates };
  }
}
