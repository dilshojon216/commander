import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WeeklyPace } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { tashkentDayOf } from '../projects/tashkent-day.js';
import { LimitsService } from './limits.service.js';
import { alertToSend } from './pace-logic.js';
import type { PaceAlertLevel } from './pace-logic.js';
import { formatPaceAlert } from './pace-format.js';

export const PACE_TICK_MS = 60_000;

/**
 * Haftalik tezlik kuzatuvchisi (6.12): har daqiqada pace'ni hisoblaydi; bir Toshkent kunida har daraja (80% / 100%) uchun BITTA
 * Telegram ogohlantirish (`pace_alerts`, `ON CONFLICT DO NOTHING` bilan egallanadi: parallel tik ikki marta yubormaydi).
 * Dashboard ogohlantirishi: `pace.alertsToday` + `limits.updated` push (`limits.changed` hodisasi).
 */
@Injectable()
export class PaceWatcherService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PaceWatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly limits: LimitsService,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['VITEST'] || process.env['PACE_WATCHER_DISABLED'] === '1') return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`pace tick failed: ${err instanceof Error ? err.message : String(err)}`)), PACE_TICK_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Yuborilgan daraja (testlar uchun) yoki null. */
  async tick(now: Date = new Date()): Promise<PaceAlertLevel | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const pace = (await this.limits.current(now)).pace ?? null;
      const day = tashkentDayOf(now);
      const rows: Array<{ level: PaceAlertLevel }> = await this.dataSource.query(`SELECT level FROM pace_alerts WHERE day = $1::date`, [day]);
      const plan = alertToSend(pace, new Set(rows.map((r) => r.level)));
      if (!plan.send || !pace) return null;
      const claimed = await this.claim(pace, day, plan.mark);
      if (!claimed.includes(plan.send)) return null; // parallel tik oldi
      await this.audit.record({
        actorKind: 'system',
        action: 'limits.pace_alert',
        target: 'limits.pace',
        details: { level: plan.send, used_today_pct: pace.usedTodayPct, allowance_pct: pace.allowancePct, source: pace.source, day },
      });
      await this.telegram?.notifyText(formatPaceAlert(pace, plan.send));
      this.bus.publish({ type: 'limits.changed' });
      return plan.send;
    } finally {
      this.running = false;
    }
  }

  private async claim(pace: WeeklyPace, day: string, levels: PaceAlertLevel[]): Promise<PaceAlertLevel[]> {
    const claimed: PaceAlertLevel[] = [];
    for (const level of levels) {
      const rows: unknown[] = await this.dataSource.query(
        `INSERT INTO pace_alerts (day, level, window_resets_at) VALUES ($1::date, $2, $3) ON CONFLICT DO NOTHING RETURNING level`,
        [day, level, pace.resetsAt],
      );
      if (rows.length > 0) claimed.push(level);
    }
    return claimed;
  }
}
