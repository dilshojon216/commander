import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@commander/contracts';
import { inTransaction } from './db.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentsLister, LiveSession } from './agents-cli.js';
import { errMsg, type Logger } from './logger.js';
import type { Outbox } from './outbox.js';
import type { SessionStore } from './session-store.js';

/** Ketma-ket shuncha marta ro'yxatda ko'rinmasa `vanished` (konservativ). */
export const VANISH_MISSES = 2;
/** Oxirgi hook'dan shuncha vaqt o'tmaguncha sessiya "yo'qolgan" hisoblanmaydi (yangi sessiya ro'yxatga kech tushishi mumkin). */
export const VANISH_GRACE_MS = 60_000;

/**
 * Har 30 s: `claude agents --json` ni agentd bilgan ochiq sessiyalar bilan solishtiradi (crash/kill'da SessionEnd hooki
 * ishlamaydi). Buyruq xatosi hisoblanmaydi (misses oshmaydi). `lastLive` heartbeat uchun.
 */
export class Reconciler {
  lastLive: LiveSession[] | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: SessionStore,
    private readonly outbox: Outbox,
    private readonly list: AgentsLister,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly onEnqueued: () => void = () => undefined,
  ) {}

  /** Qaytadi: `vanished` deb belgilangan sessiya id'lari. */
  async run(): Promise<string[]> {
    let live: LiveSession[];
    try {
      live = await this.list();
    } catch (err) {
      this.lastLive = undefined;
      this.log.warn('claude agents --json bajarilmadi (reconciliation o\'tkazib yuborildi)', { error: errMsg(err) });
      return [];
    }
    this.lastLive = live;
    const liveIds = new Set(live.map((s) => s.claudeSessionId));
    const vanished: string[] = [];

    for (const s of this.store.listOpen()) {
      if (liveIds.has(s.id)) {
        if (s.misses > 0) this.store.resetMisses(s.id);
        continue;
      }
      if (this.now() - s.lastHookAt < VANISH_GRACE_MS) continue;
      const misses = this.store.incrementMisses(s.id);
      if (misses < VANISH_MISSES) continue;

      const event: AgentEvent = {
        eventId: randomUUID(),
        claudeSessionId: s.id,
        event: 'Reconcile',
        status: 'ended',
        cwd: s.root ?? s.cwd ?? '/unknown',
        reason: 'vanished',
        ts: this.now(),
        ...(s.transcriptPath ? { transcriptPath: s.transcriptPath } : {}),
      };
      inTransaction(this.db, () => {
        this.outbox.enqueueEvent(event);
        this.store.setStatus(s.id, 'ended');
      });
      vanished.push(s.id);
      this.log.info("sessiya yo'qolgan deb belgilandi", { sessionId: s.id });
    }
    if (vanished.length > 0) this.onEnqueued();
    return vanished;
  }
}
