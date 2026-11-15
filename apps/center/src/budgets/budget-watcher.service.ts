import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { BudgetStatus } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { escapeHtml } from '../telegram/telegram-format.js';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { BudgetsService } from './budgets.service.js';
import { alertsToSend } from './budget-logic.js';
import type { AlertLevel } from './budget-logic.js';
import { formatBudgetHardAlert, formatBudgetSoftAlert, formatBudgetsTelegram } from './budget-format.js';

export const BUDGET_TICK_MS = 60_000;
/** Qattiq chegarada har sessiya uchun alohida "To'xtatish" xabari (spam bo'lmasin). */
const MAX_STOP_CARDS = 5;

interface RunningSession {
  id: string;
  name: string | null;
  project: string | null;
}

/**
 * Byudjet kuzatuvchisi (6.11): har daqiqada holatni tekshiradi; bir kunda bir daraja uchun bitta Telegram ogohlantirish
 * (`budget_alerts`). Qattiq chegarada ishlayotgan sessiyalarga "To'xtatish" tugmali xabar; `autoStop` yoqilgan bo'lsagina
 * `session.stop` buyruqlari (tizim aktori, mavjud konveyer: imzo + audit + lokal siyosat).
 */
@Injectable()
export class BudgetWatcherService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BudgetWatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private unregister: Array<() => void> = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly budgets: BudgetsService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onApplicationBootstrap(): void {
    this.unregister.push(telegramExtensions.register('budget', async () => formatBudgetsTelegram(await this.budgets.status())));
    if (process.env['VITEST'] || process.env['BUDGET_WATCHER_DISABLED'] === '1') return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`budget tick failed: ${err instanceof Error ? err.message : String(err)}`)), BUDGET_TICK_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unregister) u();
    this.unregister = [];
  }

  /** Yuborilgan ogohlantirishlar soni (testlar uchun). */
  async tick(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const status = await this.budgets.status(now);
      let sent = 0;
      for (const item of status.items) {
        if (item.state === 'ok') continue;
        if (await this.alert(item, status.day)) sent++;
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async claim(item: BudgetStatus, day: string, levels: AlertLevel[]): Promise<AlertLevel[]> {
    const claimed: AlertLevel[] = [];
    for (const level of levels) {
      const rows: unknown[] = await this.dataSource.query(
        `INSERT INTO budget_alerts (scope_kind, scope_key, day, level) VALUES ($1, $2, $3::date, $4) ON CONFLICT DO NOTHING RETURNING level`,
        [item.scopeKind, item.scopeKey, day, level],
      );
      if (rows.length > 0) claimed.push(level);
    }
    return claimed;
  }

  private async alert(item: BudgetStatus, day: string): Promise<boolean> {
    const existing: Array<{ level: AlertLevel }> = await this.dataSource.query(`SELECT level FROM budget_alerts WHERE scope_kind = $1 AND scope_key = $2 AND day = $3::date`, [item.scopeKind, item.scopeKey, day]);
    const plan = alertsToSend(item.state, new Set(existing.map((r) => r.level)));
    if (!plan.send) return false;
    const claimed = await this.claim(item, day, plan.mark);
    if (!claimed.includes(plan.send)) return false; // parallel tik oldi
    if (plan.send === 'soft') {
      await this.telegram?.notifyText(formatBudgetSoftAlert(item));
      return true;
    }
    const sessions = await this.runningSessions(item);
    await this.audit.record({ actorKind: 'system', action: 'budget.hard_reached', target: `${item.scopeKind}:${item.scopeKey.slice(0, 120)}`, details: { used: item.usedToday, limit: item.effectiveLimit, running: sessions.length, auto_stop: item.autoStop } });
    await this.telegram?.notifyText(formatBudgetHardAlert(item, sessions.length));
    for (const s of sessions.slice(0, MAX_STOP_CARDS)) {
      await this.telegram?.notifyText(`🛑 Byudjet tugadi, sessiya hali ishlayapti: <b>${escapeHtml((s.name ?? s.project ?? s.id.slice(0, 8)).slice(0, 60))}</b>`, { stopSessionId: s.id });
    }
    if (item.autoStop && sessions.length > 0) await this.autoStop(item, sessions, day);
    return true;
  }

  private async runningSessions(item: BudgetStatus): Promise<RunningSession[]> {
    return item.scopeKind === 'machine'
      ? this.dataSource.query(`SELECT s.id, s.name, s.project FROM sessions s WHERE s.machine_id = $1 AND s.ended_at IS NULL AND s.status IN ('working', 'awaiting_approval') ORDER BY s.started_at LIMIT 50`, [item.scopeKey])
      : this.dataSource.query(
          `SELECT s.id, s.name, s.project FROM sessions s JOIN projects p ON p.id = s.project_id
            WHERE COALESCE(p.repo_key, p.id::text) = $1 AND s.ended_at IS NULL AND s.status IN ('working', 'awaiting_approval') ORDER BY s.started_at LIMIT 50`,
          [item.scopeKey],
        );
  }

  /** Tizim aktori qurilmasi: byudjetni yozgan qurilma (bekor qilingan bo'lsa eng oxirgi faol klient qurilma). */
  private async actorDevice(item: BudgetStatus): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT d.id FROM devices d
        WHERE d.revoked_at IS NULL AND d.kind <> 'agentd'
        ORDER BY (d.id = (SELECT updated_by_device_id FROM budgets WHERE scope_kind = $1 AND scope_key = $2)) DESC, d.last_used_at DESC NULLS LAST LIMIT 1`,
      [item.scopeKind, item.scopeKey],
    );
    return rows[0]?.id ?? null;
  }

  private async autoStop(item: BudgetStatus, sessions: RunningSession[], day: string): Promise<void> {
    const deviceId = await this.actorDevice(item);
    if (!deviceId) {
      this.logger.warn('budget auto-stop skipped: no active client device');
      return;
    }
    for (const s of sessions) {
      try {
        await this.commands.create({ type: 'session.stop', sessionId: s.id }, { deviceId, actorKind: 'system', ip: null }, `budget-stop-${day}-${s.id.slice(0, 8)}`);
      } catch (err) {
        this.logger.warn(`budget auto-stop of session ${s.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
