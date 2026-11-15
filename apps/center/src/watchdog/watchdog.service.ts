import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_WATCHDOG_SETTINGS, ERROR_LOOP_NOTIFICATION, WATCHDOG_LIMITS, WatchdogSettingsSchema, parseErrorLoopMessage } from '@commander/contracts';
import type { AlertDto, AlertKind, AlertState, ListAlertsQuery, ListAlertsResponse, WatchdogSettings } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { LimitsService } from '../limits/limits.service.js';
import { TOKEN_WEIGHTS } from '../limits/limits-logic.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { escapeHtml } from '../telegram/telegram-format.js';
import { describeAlert, evaluate } from './watchdog-logic.js';
import type { Action, BurnSample, ErrorSample, HistoryRow, OpenAlertRow, SessionSnap } from './watchdog-logic.js';

const SETTINGS_KEY = 'watchdog.settings';
export const WATCHDOG_TICK_MS = 30_000;
const WATCHDOG_DEVICE_EXTERNAL_ID = 'watchdog';
const HISTORY_WINDOW_MS = 24 * 3_600_000;

interface AlertRow {
  id: string;
  kind: AlertKind;
  state: AlertState;
  session_id: string;
  machine_id: string;
  project_id: string | null;
  episode_key: string;
  title: string;
  detail: string;
  payload: Record<string, number | string | null>;
  reminders_sent: number;
  last_notified_at: Date | null;
  auto_stopped: boolean;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  session_name: string | null;
  project_name: string | null;
  claude_session_id: string | null;
}

const SELECT_ALERT = `SELECT a.*, s.name AS session_name, COALESCE(p.name, s.project) AS project_name, s.claude_session_id
  FROM watchdog_alerts a JOIN sessions s ON s.id = a.session_id LEFT JOIN projects p ON p.id = a.project_id`;

export function toAlertDto(r: AlertRow): AlertDto {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    sessionId: r.session_id,
    machineId: r.machine_id,
    projectId: r.project_id,
    sessionName: r.session_name ?? (r.claude_session_id ? r.claude_session_id.slice(0, 8) : null),
    projectName: r.project_name,
    title: r.title,
    detail: r.detail,
    metrics: r.payload ?? {},
    remindersSent: r.reminders_sent,
    autoStopped: r.auto_stopped,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

const KIND_ICON: Record<AlertKind, string> = { waiting: '⏳', burn: '🔥', error_loop: '🔁' };

/** Telegram matni (HTML): faqat raqam va nomlar; foydalanuvchi matni yo'q. */
export function formatAlertText(dto: Pick<AlertDto, 'kind' | 'title' | 'detail' | 'projectName' | 'sessionName' | 'autoStopped'>, reminder: number | null): string {
  const head = `${KIND_ICON[dto.kind]} <b>${escapeHtml(dto.title)}</b>${reminder !== null ? ` (eslatma ${reminder})` : ''}`;
  const where = [dto.projectName, dto.sessionName].filter((x): x is string => !!x).map(escapeHtml).join(' · ');
  const lines = [head, ...(where ? [where] : []), escapeHtml(dto.detail)];
  if (dto.autoStopped) lines.push('⏹ Avtomatik to\'xtatish yuborildi');
  return lines.join('\n');
}

/**
 * Watchdog (3.2). Har `WATCHDOG_TICK_MS` da holatni o'qiydi, sof `evaluate()` bilan harakatlarni hisoblaydi va qo'llaydi.
 * Xato tickni to'xtatmaydi (log). Bitta center jarayoni deb faraz qilingan; takroriy ogohlantirishni DB'dagi qisman UNIQUE ham to'sadi.
 * Avtomatik to'xtatish: faqat `autoStop` yoqilgan joyda, mavjud buyruq konveyeri orqali (audit + lockdown + policy), `system` aktyor.
 */
@Injectable()
export class WatchdogService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WatchdogService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private deviceId: string | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bus: RealtimeBus,
    private readonly limits: LimitsService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['WATCHDOG_DISABLED'] === '1') return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`)), WATCHDOG_TICK_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- sozlamalar ---------------------------------------------------------------------------------

  async getSettings(): Promise<WatchdogSettings> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
    const parsed = WatchdogSettingsSchema.safeParse({ ...DEFAULT_WATCHDOG_SETTINGS, ...(rows[0]?.value as object | undefined) });
    return parsed.success ? parsed.data : DEFAULT_WATCHDOG_SETTINGS;
  }

  async putSettings(next: WatchdogSettings): Promise<WatchdogSettings> {
    await this.dataSource.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTINGS_KEY, JSON.stringify(next)],
    );
    return next;
  }

  // --- o'qish -------------------------------------------------------------------------------------

  async list(q: ListAlertsQuery): Promise<ListAlertsResponse> {
    const rows: AlertRow[] = await this.dataSource.query(`${SELECT_ALERT} ${q.state === 'open' ? `WHERE a.state = 'open'` : ''} ORDER BY a.created_at DESC LIMIT $1`, [q.limit]);
    return { items: rows.map(toAlertDto) };
  }

  async getDto(id: string): Promise<AlertDto> {
    const rows: AlertRow[] = await this.dataSource.query(`${SELECT_ALERT} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Alert not found' });
    return toAlertDto(rows[0]);
  }

  /** Foydalanuvchi rad etdi: epizod qayta ochilmaydi (history'da qoladi). Allaqachon yopilgan bo'lsa o'zgarmaydi. */
  async dismiss(id: string): Promise<AlertDto> {
    const done: unknown[] = await this.dataSource.query(`UPDATE watchdog_alerts SET state = 'dismissed', resolved_at = now(), updated_at = now() WHERE id = $1 AND state = 'open' RETURNING id`, [id]);
    const dto = await this.getDto(id);
    if (done.length > 0) this.bus.publish({ type: 'alert.changed', alert: dto, created: false });
    return dto;
  }

  // --- tick ---------------------------------------------------------------------------------------

  async tick(now: Date = new Date()): Promise<Action[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const settings = await this.getSettings();
      const open = await this.openAlerts();
      const sessions = await this.sessionSnaps(open);
      const [burn, errors, history, coefficient] = await Promise.all([this.burnSamples(now), this.errorSamples(now), this.history(now), this.coefficient(now)]);
      const actions = evaluate({ now, settings, sessions, burn, errors, fiveHourCoefficient: coefficient, open, history });
      for (const a of actions) {
        try {
          await this.apply(a, now);
        } catch (err) {
          this.logger.error(`apply ${a.type} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return actions;
    } finally {
      this.running = false;
    }
  }

  private async coefficient(now: Date): Promise<number | null> {
    try {
      return (await this.limits.current(now)).fiveHour?.calibration?.coefficient ?? null;
    } catch (err) {
      this.logger.warn(`limits unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async openAlerts(): Promise<OpenAlertRow[]> {
    const rows: Array<{ id: string; kind: AlertKind; session_id: string; episode_key: string; created_at: Date; last_notified_at: Date | null; reminders_sent: number; payload: Record<string, number | string | null> }> =
      await this.dataSource.query(`SELECT id, kind, session_id, episode_key, created_at, last_notified_at, reminders_sent, payload FROM watchdog_alerts WHERE state = 'open'`);
    return rows.map((r) => ({ id: r.id, kind: r.kind, sessionId: r.session_id, episodeKey: r.episode_key, createdAt: r.created_at, lastNotifiedAt: r.last_notified_at, remindersSent: r.reminders_sent, metrics: r.payload ?? {} }));
  }

  private async sessionSnaps(open: readonly OpenAlertRow[]): Promise<SessionSnap[]> {
    const rows: Array<{ id: string; machine_id: string; project_id: string | null; status: SessionSnap['status']; status_since: Date; ended_at: Date | null; stale_since: Date | null }> =
      await this.dataSource.query(
        `SELECT id, machine_id, project_id, status, status_since, ended_at, stale_since FROM sessions WHERE ended_at IS NULL OR id = ANY($1::uuid[])`,
        [open.map((o) => o.sessionId)],
      );
    return rows.map((r) => ({ id: r.id, machineId: r.machine_id, projectId: r.project_id, status: r.status, statusSince: r.status_since, endedAt: r.ended_at, staleSince: r.stale_since }));
  }

  private async burnSamples(now: Date): Promise<BurnSample[]> {
    const since = new Date(now.getTime() - WATCHDOG_LIMITS.burnWindowMs);
    const w = TOKEN_WEIGHTS;
    const rows: Array<{ id: string; weighted: number }> = await this.dataSource.query(
      `SELECT s.id, sum(tu.input_tokens * ${w.input} + tu.output_tokens * ${w.output} + tu.cache_creation_tokens * ${w.cacheCreation} + tu.cache_read_tokens * ${w.cacheRead})::float8 AS weighted
         FROM token_usage tu JOIN sessions s ON s.machine_id = tu.machine_id AND s.claude_session_id = tu.session_id
        WHERE tu.ts > $1 AND tu.ts <= $2 GROUP BY s.id`,
      [since, now],
    );
    return rows.map((r) => ({ sessionId: r.id, weighted10m: Number(r.weighted) }));
  }

  private async errorSamples(now: Date): Promise<ErrorSample[]> {
    const since = new Date(now.getTime() - WATCHDOG_LIMITS.errorLoopWindowMs);
    const rows: Array<{ session_id: string; message: string | null }> = await this.dataSource.query(
      `SELECT session_id, message FROM session_events WHERE notification_type = $1 AND ts > $2 AND ts <= $3`,
      [ERROR_LOOP_NOTIFICATION, since, now],
    );
    const best = new Map<string, ErrorSample>();
    for (const r of rows) {
      const p = parseErrorLoopMessage(r.message);
      if (!p) continue;
      const k = `${r.session_id}|${p.hash}`;
      const cur = best.get(k);
      if (!cur || p.count > cur.count) best.set(k, { sessionId: r.session_id, hash: p.hash, count: p.count });
    }
    return [...best.values()];
  }

  private async history(now: Date): Promise<HistoryRow[]> {
    const rows: Array<{ session_id: string; kind: AlertKind; episode_key: string; created_at: Date }> = await this.dataSource.query(
      `SELECT session_id, kind, episode_key, created_at FROM watchdog_alerts WHERE created_at > $1`,
      [new Date(now.getTime() - HISTORY_WINDOW_MS)],
    );
    return rows.map((r) => ({ sessionId: r.session_id, kind: r.kind, episodeKey: r.episode_key, createdAt: r.created_at }));
  }

  // --- harakatlarni qo'llash ----------------------------------------------------------------------

  private async apply(a: Action, now: Date): Promise<void> {
    if (a.type === 'create') return this.applyCreate(a, now);
    if (a.type === 'remind') {
      const dto = await this.getDto(a.alert.id);
      await this.dataSource.query(`UPDATE watchdog_alerts SET reminders_sent = reminders_sent + 1, last_notified_at = $2, updated_at = $2 WHERE id = $1 AND state = 'open'`, [a.alert.id, now]);
      await this.notify(dto, a.alert.remindersSent + 1);
      this.bus.publish({ type: 'alert.changed', alert: await this.getDto(a.alert.id), created: false });
      return;
    }
    if (a.type === 'update') {
      const d = describeAlert(a.alert.kind, a.metrics);
      await this.dataSource.query(`UPDATE watchdog_alerts SET payload = $2::jsonb, detail = $3, updated_at = $4 WHERE id = $1 AND state = 'open'`, [a.alert.id, JSON.stringify(a.metrics), d.detail, now]);
    } else {
      await this.dataSource.query(`UPDATE watchdog_alerts SET state = 'resolved', resolved_at = $2, updated_at = $2 WHERE id = $1 AND state = 'open'`, [a.alert.id, now]);
    }
    this.bus.publish({ type: 'alert.changed', alert: await this.getDto(a.alert.id), created: false });
  }

  private async applyCreate(a: Extract<Action, { type: 'create' }>, now: Date): Promise<void> {
    const d = describeAlert(a.kind, a.metrics);
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO watchdog_alerts (kind, session_id, machine_id, project_id, episode_key, title, detail, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9) ON CONFLICT DO NOTHING RETURNING id`,
      [a.kind, a.session.id, a.session.machineId, a.session.projectId, a.episodeKey, d.title, d.detail, JSON.stringify(a.metrics), now],
    );
    const id = rows[0]?.id;
    if (!id) return; // poyga: boshqa tick/jarayon yaratib bo'lgan
    let dto = await this.getDto(id);
    this.bus.publish({ type: 'alert.changed', alert: dto, created: true });

    if (a.autoStop && a.kind !== 'waiting') {
      const stopped = await this.autoStop(id, a.session.id, a.kind);
      if (stopped) {
        await this.dataSource.query(`UPDATE watchdog_alerts SET auto_stopped = true, updated_at = now() WHERE id = $1`, [id]);
        dto = await this.getDto(id);
        this.bus.publish({ type: 'alert.changed', alert: dto, created: false });
      }
    }
    await this.notify(dto, null);
    await this.dataSource.query(`UPDATE watchdog_alerts SET last_notified_at = $2 WHERE id = $1`, [id, now]);
  }

  private async notify(dto: AlertDto, reminder: number | null): Promise<void> {
    if (!this.telegram) return;
    try {
      // 6.4: har ogohlantirishda "🔍 Claude tekshirsin" (plan rejimidagi tekshiruv; ikki bosqichli tasdiq Telegram'da)
      await this.telegram.notifyText(formatAlertText(dto, reminder), { ...(dto.kind !== 'waiting' && !dto.autoStopped ? { stopSessionId: dto.sessionId } : {}), investigate: { kind: 'watchdog', id: dto.id } });
    } catch (err) {
      this.logger.warn(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `session.stop` buyrug'i (system aktyor) + audit. Rad etilsa (lockdown, offline, policy) false: ogohlantirish baribir qoladi. */
  private async autoStop(alertId: string, sessionId: string, kind: AlertKind): Promise<boolean> {
    try {
      const deviceId = await this.systemDevice();
      await this.audit.record({ actorDeviceId: deviceId, actorKind: 'system', action: 'watchdog.auto_stop', target: sessionId, details: { alert_id: alertId, kind } });
      const res = await this.commands.create({ type: 'session.stop', sessionId }, { deviceId, actorKind: 'system', ip: null }, `watchdog-${alertId}`);
      return !['failed', 'rejected', 'expired'].includes(res.command.status);
    } catch (err) {
      this.logger.warn(`auto-stop failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Tokensiz `web` qurilma (autentifikatsiya qila olmaydi): faqat buyruq jurnalidagi aktyor identifikatori. */
  private async systemDevice(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO devices (kind, name, external_id, scopes) VALUES ('web', 'watchdog', $1, ARRAY['read','control']::text[])
       ON CONFLICT (kind, external_id) DO UPDATE SET name = devices.name RETURNING id`,
      [WATCHDOG_DEVICE_EXTERNAL_ID],
    );
    this.deviceId = rows[0]!.id;
    return this.deviceId;
  }
}
