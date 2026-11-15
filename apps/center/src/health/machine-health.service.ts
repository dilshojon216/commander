import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  AgentHealthPayload,
  HealthRange,
  HealthSeriesPoint,
  HealthSnapshot,
  HealthStatus,
  HealthSummaryItem,
  HealthSummaryResponse,
  MachineHealthResponse,
} from '@commander/contracts';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { HealthIncidentsService } from './health-incidents.service.js';
import { computeStatus, isBadContainer, keyNumbers, mergeSnapshot, worstStatus } from './health-merge.js';
import { HealthThresholdsService } from './health-thresholds.service.js';

export interface LatestHealth {
  snapshot: HealthSnapshot;
  receivedAt: Date;
}

/** Ingest'dan keyin chaqiriladi (health-alerts shu orqali ulanadi; modul sikli yo'q). Xatosi ingest'ni yiqitmaydi. */
export type HealthListener = (machineId: string, snapshot: HealthSnapshot, now: number) => Promise<void>;

const RANGE_MS: Record<HealthRange, number> = { '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 };
/** Kelajakdagi `collectedAt` (soat siljishi) shuncha dan oshmasin. */
const MAX_FUTURE_MS = 60_000;
/** Bitta mashinadan shu oraliqdan tez kelgan yozuvlar tashlanadi (xato/zararli agentd DB'ni to'ldirmasin). */
export const DEFAULT_MIN_INTERVAL_MS = 5_000;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

@Injectable()
export class MachineHealthService {
  private readonly logger = new Logger(MachineHealthService.name);
  private readonly latestCache = new Map<string, LatestHealth>();
  private readonly lastAccepted = new Map<string, number>();
  private readonly listeners: HealthListener[] = [];
  /** Testlarda 0 qilinadi. */
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bus: RealtimeBus,
    private readonly incidents: HealthIncidentsService,
    private readonly thresholds: HealthThresholdsService,
  ) {}

  onSnapshot(listener: HealthListener): void {
    this.listeners.push(listener);
  }

  /** Oxirgi to'liq snapshot (kesh -> DB). */
  async latest(machineId: string): Promise<LatestHealth | null> {
    const hit = this.latestCache.get(machineId);
    if (hit) return hit;
    const rows: Array<{ snapshot: HealthSnapshot; received_at: Date }> = await this.dataSource.query(
      `SELECT snapshot, received_at FROM machine_health_latest WHERE machine_id = $1`,
      [machineId],
    );
    const r = rows[0];
    if (!r) return null;
    const v = { snapshot: r.snapshot, receivedAt: r.received_at };
    this.latestCache.set(machineId, v);
    return v;
  }

  /**
   * `agent.health` ni qabul qiladi: birlashtiradi, `machine_health` + `machine_health_latest` ga yozadi, klientlarga e'lon
   * qiladi va tinglovchilarni (alertlar) chaqiradi. Haddan tez kelgan yuk jim tashlanadi (qaytadi: yozildimi).
   */
  async ingest(machineId: string, p: AgentHealthPayload, now: number = Date.now()): Promise<boolean> {
    const last = this.lastAccepted.get(machineId);
    if (last !== undefined && now - last < this.minIntervalMs) return false;
    this.lastAccepted.set(machineId, now);

    const prev = (await this.latest(machineId))?.snapshot ?? null;
    const collectedAt = Math.min(p.collectedAt, now + MAX_FUTURE_MS);
    const merged = mergeSnapshot(prev, { ...p, collectedAt });
    const k = keyNumbers(merged);
    const ts = new Date(Math.min(collectedAt, now));
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO machine_health (ts, machine_id, cpu, mem_pct, disk_max_pct, metrics) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (machine_id, ts) DO NOTHING`,
        [ts, machineId, k.cpu, k.memPct, k.diskMaxPct, JSON.stringify(p)],
      );
      await m.query(
        `INSERT INTO machine_health_latest (machine_id, ts, snapshot, received_at) VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (machine_id) DO UPDATE SET ts = EXCLUDED.ts, snapshot = EXCLUDED.snapshot, received_at = now()`,
        [machineId, ts, JSON.stringify(merged)],
      );
      await m.query(`UPDATE machines SET last_seen_at = now() WHERE id = $1`, [machineId]);
    });
    this.latestCache.set(machineId, { snapshot: merged, receivedAt: new Date(now) });
    this.bus.publish({ type: 'health.changed', machineId });
    for (const l of this.listeners) {
      l(machineId, merged, now).catch((err: unknown) => this.logger.error(`health listener failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return true;
  }

  /** Mashina holati (ochiq hodisalar + eskirganlik + online). */
  async statusOf(machineId: string, online: boolean, now = Date.now()): Promise<{ status: HealthStatus; latest: LatestHealth | null }> {
    const [latest, open] = await Promise.all([this.latest(machineId), this.incidents.open(machineId)]);
    const status = computeStatus({ online, snapshotAt: latest?.receivedAt.getTime() ?? null, now, openSeverities: open.map((o) => o.severity) });
    return { status, latest };
  }

  async machineHealth(machineId: string, range: HealthRange, now = Date.now()): Promise<MachineHealthResponse> {
    const mrows: Array<{ online: boolean }> = await this.dataSource.query(`SELECT online FROM machines WHERE id = $1 AND merged_into_id IS NULL`, [machineId]);
    if (!mrows[0]) throw new NotFoundException({ error: 'machine_not_found', message: 'machine not found' });
    const since = new Date(now - RANGE_MS[range]);
    const [{ status, latest }, series, incidents, thresholds] = await Promise.all([
      this.statusOf(machineId, mrows[0].online, now),
      this.series(machineId, range, since),
      this.incidents.forMachine(machineId, since.getTime()),
      this.thresholds.forMachine(machineId),
    ]);
    return { machineId, range, status, latest: latest?.snapshot ?? null, receivedAt: iso(latest?.receivedAt ?? null), series, incidents, thresholds };
  }

  /** 6h: xom jadval (1 daqiqalik bucket); 24h: 5 daqiqalik cagg; 7d: cagg'dan 30 daqiqalik bucket. */
  private async series(machineId: string, range: HealthRange, since: Date): Promise<HealthSeriesPoint[]> {
    const sql =
      range === '6h'
        ? `SELECT time_bucket(INTERVAL '1 minute', ts) AS b, avg(cpu) AS cpu, avg(mem_pct) AS mem, max(disk_max_pct) AS disk
             FROM machine_health WHERE machine_id = $1 AND ts >= $2 GROUP BY 1 ORDER BY 1`
        : range === '24h'
          ? `SELECT bucket AS b, cpu_avg AS cpu, mem_avg AS mem, disk_max AS disk
               FROM machine_health_5m WHERE machine_id = $1 AND bucket >= $2 ORDER BY 1`
          : `SELECT time_bucket(INTERVAL '30 minutes', bucket) AS b, avg(cpu_avg) AS cpu, avg(mem_avg) AS mem, max(disk_max) AS disk
               FROM machine_health_5m WHERE machine_id = $1 AND bucket >= $2 GROUP BY 1 ORDER BY 1`;
    const rows: Array<{ b: Date; cpu: string | null; mem: string | null; disk: string | null }> = await this.dataSource.query(sql, [machineId, since]);
    const n = (v: string | null): number | null => (v === null ? null : Math.round(Number(v) * 10) / 10);
    return rows.map((r) => ({ ts: r.b.getTime(), cpu: n(r.cpu), memPct: n(r.mem), diskMaxPct: n(r.disk) }));
  }

  async summary(now = Date.now()): Promise<HealthSummaryResponse> {
    const rows: Array<{
      id: string;
      name: string;
      online: boolean;
      snapshot: HealthSnapshot | null;
      received_at: Date | null;
      open_warn: number;
      open_critical: number;
    }> = await this.dataSource.query(`
      SELECT m.id, COALESCE(m.display_name, m.hostname, m.slug) AS name, m.online, l.snapshot, l.received_at,
             COALESCE(i.warn, 0)::int AS open_warn, COALESCE(i.critical, 0)::int AS open_critical
        FROM machines m
        LEFT JOIN machine_health_latest l ON l.machine_id = m.id
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE severity = 'warn') AS warn, count(*) FILTER (WHERE severity = 'critical') AS critical
            FROM health_incidents WHERE machine_id = m.id AND resolved_at IS NULL
        ) i ON true
       WHERE m.merged_into_id IS NULL AND m.status = 'active'
       ORDER BY name`);
    const items: HealthSummaryItem[] = rows.map((r) => {
      const k = r.snapshot ? keyNumbers(r.snapshot) : null;
      const sev: Array<'warn' | 'critical'> = [...Array<'warn'>(r.open_warn).fill('warn'), ...Array<'critical'>(r.open_critical).fill('critical')];
      const containers = r.snapshot?.docker?.containers ?? [];
      return {
        machineId: r.id,
        name: r.name,
        online: r.online,
        status: computeStatus({ online: r.online, snapshotAt: r.received_at?.getTime() ?? null, now, openSeverities: sev }),
        cpuPct: k?.cpu ?? null,
        memPct: k?.memPct ?? null,
        diskMaxPct: k?.diskMaxPct ?? null,
        diskMaxMount: k?.diskMaxMount ?? null,
        containersTotal: containers.length,
        containersBad: containers.filter(isBadContainer).length,
        failedUnits: r.snapshot?.systemd?.failed.length ?? 0,
        receivedAt: iso(r.received_at),
        openIncidents: r.open_warn + r.open_critical,
      };
    });
    return { items, worst: worstStatus(items.map((i) => i.status)) };
  }
}
