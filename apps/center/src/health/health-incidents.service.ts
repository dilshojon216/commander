import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { HealthIncidentDto, IncidentKind, IncidentSeverity, ListHealthIncidentsQuery } from '@commander/contracts';
import type { Condition } from './health-rules.js';
import type { OpenIncident } from './incident-state.js';

interface IncidentRow {
  id: string;
  machine_id: string;
  machine_name: string;
  kind: IncidentKind;
  subject: string;
  severity: IncidentSeverity;
  summary: string;
  opened_at: Date;
  resolved_at: Date | null;
}

export const toIncidentDto = (r: IncidentRow): HealthIncidentDto => ({
  id: r.id,
  machineId: r.machine_id,
  machineName: r.machine_name,
  kind: r.kind,
  subject: r.subject,
  severity: r.severity,
  summary: r.summary,
  openedAt: r.opened_at.toISOString(),
  resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
});

const SELECT = `
  SELECT i.id, i.machine_id, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, i.kind, i.subject, i.severity,
         i.summary, i.opened_at, i.resolved_at
    FROM health_incidents i JOIN machines m ON m.id = i.machine_id`;

/** `health_incidents` jadvali: ochiq/yopiq hodisalar (ochiq hodisa uchun (machine, kind, subject) noyob). */
@Injectable()
export class HealthIncidentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async open(machineId: string): Promise<OpenIncident[]> {
    const rows: Array<{ id: string; kind: IncidentKind; subject: string; severity: IncidentSeverity }> = await this.dataSource.query(
      `SELECT id, kind, subject, severity FROM health_incidents WHERE machine_id = $1 AND resolved_at IS NULL`,
      [machineId],
    );
    return rows;
  }

  /** Yangi hodisa; ochiq dublikat bo'lsa (poyga) `null` (xabar yuborilmaydi). */
  async create(machineId: string, c: Condition): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO health_incidents (machine_id, kind, subject, severity, summary) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (machine_id, kind, subject) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
      [machineId, c.kind, c.subject, c.severity, c.summary.slice(0, 300)],
    );
    return rows[0]?.id ?? null;
  }

  async update(id: string, c: Condition): Promise<void> {
    await this.dataSource.query(`UPDATE health_incidents SET severity = $2, summary = $3 WHERE id = $1 AND resolved_at IS NULL`, [id, c.severity, c.summary.slice(0, 300)]);
  }

  /** Yopadi; haqiqatan yopilgan bo'lsa true (ikki marta "tiklandi" yuborilmasin). CTE: TypeORM UPDATE..RETURNING `[rows, count]` qaytaradi. */
  async resolve(id: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(`WITH u AS (UPDATE health_incidents SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING id) SELECT id FROM u`, [id]);
    return rows.length > 0;
  }

  async markNotified(id: string): Promise<void> {
    await this.dataSource.query(`UPDATE health_incidents SET notified_at = now() WHERE id = $1`, [id]);
  }

  async get(id: string): Promise<HealthIncidentDto | null> {
    const rows: IncidentRow[] = await this.dataSource.query(`${SELECT} WHERE i.id = $1`, [id]);
    return rows[0] ? toIncidentDto(rows[0]) : null;
  }

  async list(q: ListHealthIncidentsQuery): Promise<HealthIncidentDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.machineId) {
      params.push(q.machineId);
      where.push(`i.machine_id = $${params.length}`);
    }
    if (q.state === 'open') where.push('i.resolved_at IS NULL');
    if (q.state === 'resolved') where.push('i.resolved_at IS NOT NULL');
    params.push(q.limit);
    const rows: IncidentRow[] = await this.dataSource.query(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (i.resolved_at IS NULL) DESC, i.opened_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toIncidentDto);
  }

  /** Ochiq hodisalar + oxirgi `sinceMs` ichida yopilganlar (mashina sahifasi uchun). */
  async forMachine(machineId: string, sinceMs: number, limit = 50): Promise<HealthIncidentDto[]> {
    const rows: IncidentRow[] = await this.dataSource.query(
      `${SELECT} WHERE i.machine_id = $1 AND (i.resolved_at IS NULL OR i.resolved_at >= $2) ORDER BY (i.resolved_at IS NULL) DESC, i.opened_at DESC LIMIT $3`,
      [machineId, new Date(sinceMs), limit],
    );
    return rows.map(toIncidentDto);
  }
}
