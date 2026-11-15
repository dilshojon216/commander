import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleInit, BeforeApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { HealthSnapshot, IncidentKind, IncidentSeverity } from '@commander/contracts';
import { HealthIncidentsService } from '../health/health-incidents.service.js';
import { HealthThresholdsService } from '../health/health-thresholds.service.js';
import { MachineConditionTracker } from '../health/health-rules.js';
import type { Condition } from '../health/health-rules.js';
import { planIncidents } from '../health/incident-state.js';
import { MachineHealthService } from '../health/machine-health.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { formatIncidentOpened, formatIncidentResolved } from './health-alert-format.js';
import type { IncidentText } from './health-alert-format.js';

const SWEEP_MS = 60_000;

/** Tekshiruv tugmasi: offline hodisadan tashqari (mashinaga yetib bo'lmaydi). */
const investigable = (kind: IncidentKind, id: string): { kind: 'health'; id: string } | undefined => (kind === 'offline' ? undefined : { kind: 'health', id });

/**
 * Salomatlik ogohlantirishlari (3.8): `agent.health` snapshot'larini chegaralar bilan solishtiradi, hodisa holat mashinasini
 * yuritadi (ochilish = Telegram BIR marta, jiddiylashish = yana bir marta, tiklanish = "tiklandi") va offline supurgichini
 * ishga tushiradi. Telegram o'chiq bo'lsa hodisalar baribir yoziladi (dashboard ko'rsatadi).
 */
@Injectable()
export class HealthAlertsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthAlertsService.name);
  private readonly trackers = new Map<string, MachineConditionTracker>();
  private readonly chains = new Map<string, Promise<void>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly health: MachineHealthService,
    private readonly incidents: HealthIncidentsService,
    private readonly thresholds: HealthThresholdsService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onModuleInit(): void {
    this.health.onSnapshot((machineId, snapshot, now) => this.evaluate(machineId, snapshot, now));
    this.sweepTimer = setInterval(() => void this.sweepOffline().catch((err: unknown) => this.logger.error(`offline sweep failed: ${err instanceof Error ? err.message : String(err)}`)), SWEEP_MS);
    this.sweepTimer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Mashina bo'yicha ketma-ket (bir vaqtda ikki baholash dublikat xabar bermasin). */
  evaluate(machineId: string, snapshot: HealthSnapshot, now: number): Promise<void> {
    const prev = this.chains.get(machineId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.evaluateNow(machineId, snapshot, now));
    this.chains.set(machineId, next);
    void next.catch(() => undefined).finally(() => {
      if (this.chains.get(machineId) === next) this.chains.delete(machineId);
    });
    return next;
  }

  private async machineName(machineId: string): Promise<string> {
    const rows: Array<{ name: string }> = await this.dataSource.query(`SELECT COALESCE(display_name, hostname, slug) AS name FROM machines WHERE id = $1`, [machineId]);
    return rows[0]?.name ?? machineId;
  }

  private async evaluateNow(machineId: string, snapshot: HealthSnapshot, now: number): Promise<void> {
    const t = await this.thresholds.forMachine(machineId);
    const open = await this.incidents.open(machineId);
    let tracker = this.trackers.get(machineId);
    if (!tracker) this.trackers.set(machineId, (tracker = new MachineConditionTracker()));
    const openDisk = new Map(open.filter((o) => o.kind === 'disk').map((o) => [o.subject, o.severity] as const));
    const { conditions, evaluated } = tracker.evaluate(snapshot, t, now, openDisk);
    const plan = planIncidents(open, conditions, evaluated);
    if (plan.open.length + plan.escalate.length + plan.downgrade.length + plan.resolve.length === 0) return;

    const name = await this.machineName(machineId);
    const text = (c: { kind: IncidentKind; severity: IncidentSeverity; summary: string }): IncidentText => ({ machineName: name, kind: c.kind, severity: c.severity, summary: c.summary });

    for (const c of plan.open) {
      const id = await this.incidents.create(machineId, c);
      // 6.4: offline hodisada tekshiruv ma'nosiz (agentd ulanmagan), qolganlarida "🔍 Claude tekshirsin"
      if (id && (await this.send(formatIncidentOpened(text(c)), investigable(c.kind, id)))) await this.incidents.markNotified(id);
    }
    for (const e of plan.escalate) {
      await this.incidents.update(e.id, e.condition);
      if (await this.send(formatIncidentOpened(text(e.condition), true), investigable(e.condition.kind, e.id))) await this.incidents.markNotified(e.id);
    }
    for (const d of plan.downgrade) await this.incidents.update(d.id, d.condition);
    for (const r of plan.resolve) await this.close(r.id, name, now);
  }

  private async close(id: string, machineName: string, now: number): Promise<void> {
    const dto = await this.incidents.get(id);
    if (!(await this.incidents.resolve(id)) || !dto) return;
    await this.send(formatIncidentResolved({ machineName, kind: dto.kind, severity: dto.severity, summary: dto.summary }, new Date(dto.openedAt), new Date(now)));
  }

  /**
   * Offline supurgich: tasdiqlangan mashina `offlineAfterMin` daqiqadan beri ulanmagan bo'lsa `offline` hodisasi (bir marta);
   * qaytsa yopiladi + "qayta aloqada". Center qayta ishga tushganda hamma offline: `offlineAfterMin` kutiladi.
   */
  async sweepOffline(now: number = Date.now()): Promise<void> {
    const machines: Array<{ id: string; name: string; online: boolean; since: Date | null }> = await this.dataSource.query(`
      SELECT id, COALESCE(display_name, hostname, slug) AS name, online, COALESCE(disconnected_at, last_seen_at) AS since
        FROM machines WHERE merged_into_id IS NULL AND status = 'active' AND identity_status = 'verified'`);
    const open = await this.dataSource.query(`SELECT id, machine_id FROM health_incidents WHERE kind = 'offline' AND resolved_at IS NULL`) as Array<{ id: string; machine_id: string }>;
    const openBy = new Map(open.map((o) => [o.machine_id, o.id]));
    for (const m of machines) {
      const incidentId = openBy.get(m.id);
      if (m.online) {
        if (incidentId) await this.close(incidentId, m.name, now);
        continue;
      }
      if (incidentId || !m.since) continue;
      const t = await this.thresholds.forMachine(m.id);
      const downMs = now - m.since.getTime();
      if (downMs < t.offlineAfterMin * 60_000) continue;
      const c: Condition = { kind: 'offline', subject: '', severity: 'critical', summary: `agentd ${Math.round(downMs / 60_000)} daqiqadan beri ulanmagan` };
      const id = await this.incidents.create(m.id, c);
      if (id && (await this.send(formatIncidentOpened({ machineName: m.name, kind: 'offline', severity: 'critical', summary: c.summary })))) await this.incidents.markNotified(id);
    }
  }

  /** Telegram'ga yuboradi; yuborilganmi. Telegram o'chiq/xato = false (log), hodisa baribir saqlanadi. */
  private async send(text: string, investigate?: { kind: 'health'; id: string }): Promise<boolean> {
    if (!this.telegram) return false;
    try {
      return (await (investigate ? this.telegram.notifyText(text, { investigate }) : this.telegram.notifyText(text))) > 0;
    } catch (err) {
      this.logger.warn(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
