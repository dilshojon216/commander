import { HEALTH_LIMITS } from '@commander/contracts';
import type { AgentHealthPayload } from '@commander/contracts';
import { errMsg, type Logger } from '../logger.js';
import { HealthCollector } from './collector.js';
import { HealthDeltaTracker } from './delta.js';

export interface HealthTransport {
  isReady(): boolean;
  /** Jonli yuborish (ack/outbox yo'q). `false` = yuborilmadi. */
  send(payload: AgentHealthPayload): boolean;
}

export interface HealthReporterDeps {
  collector: HealthCollector;
  transport: HealthTransport;
  log: Logger;
  intervalMs?: number;
  fullEveryMs?: number;
  now?: () => number;
}

/** Har 30 s yig'ib `agent.health` yuboradi. Ulanish yo'q bo'lsa yig'maydi (kech kelgan eski o'lchovning foydasi yo'q). */
export class HealthReporter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private wasReady = false;
  private readonly tracker: HealthDeltaTracker;
  private readonly now: () => number;

  constructor(private readonly d: HealthReporterDeps) {
    this.tracker = new HealthDeltaTracker(d.fullEveryMs ?? HEALTH_LIMITS.fullEveryMs);
    this.now = d.now ?? Date.now;
  }

  start(firstDelayMs = 5_000): void {
    this.d.collector.prime();
    const tick = (): void => void this.tick();
    const first = setTimeout(tick, firstDelayMs);
    first.unref();
    this.timer = setInterval(tick, this.d.intervalMs ?? HEALTH_LIMITS.intervalMs);
    this.timer.unref();
    this.firstTimer = first;
  }

  private firstTimer: NodeJS.Timeout | null = null;

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = this.firstTimer = null;
  }

  /** Bitta davr (testlar to'g'ridan-to'g'ri chaqiradi). Qaytadi: yuborildimi. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    const ready = this.d.transport.isReady();
    if (!ready) {
      this.wasReady = false;
      return false;
    }
    if (!this.wasReady) {
      this.wasReady = true;
      this.tracker.reset(); // qayta ulandi: markaz bazasi eskirgan bo'lishi mumkin
    }
    this.running = true;
    try {
      const snap = await this.d.collector.collect();
      const payload = this.tracker.next(snap, this.now());
      const ok = this.d.transport.send(payload);
      if (!ok) this.tracker.reset();
      return ok;
    } catch (err) {
      this.d.log.warn('salomatlik yig\'ish xatosi', { error: errMsg(err) });
      return false;
    } finally {
      this.running = false;
    }
  }
}
