import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { CenterCheckKind, CenterIncidentDto } from '@commander/contracts';
import type { Desired, OpenCenterIncident } from './center-checks.js';

interface Row {
  id: string;
  kind: CenterCheckKind;
  severity: 'warn' | 'critical';
  summary: string;
  opened_at: Date;
  resolved_at: Date | null;
}

const toDto = (r: Row): CenterIncidentDto => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  summary: r.summary,
  openedAt: r.opened_at.toISOString(),
  resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
});

/** `center_incidents` jadvali (har tur uchun bitta ochiq hodisa: qisman UNIQUE indeks). Mashina hodisalari: `HealthIncidentsService`. */
@Injectable()
export class CenterIncidentsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async open(): Promise<OpenCenterIncident[]> {
    return this.dataSource.query(`SELECT id, kind, severity FROM center_incidents WHERE resolved_at IS NULL`);
  }

  /** Yangi hodisa; ochiq dublikat bo'lsa (poyga) `null` (xabar yuborilmaydi). */
  async create(d: Desired): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO center_incidents (kind, severity, summary) VALUES ($1, $2, $3)
       ON CONFLICT (kind) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
      [d.kind, d.severity, d.summary.slice(0, 300)],
    );
    return rows[0]?.id ?? null;
  }

  async update(id: string, d: Desired): Promise<void> {
    await this.dataSource.query(`UPDATE center_incidents SET severity = $2, summary = $3 WHERE id = $1 AND resolved_at IS NULL`, [id, d.severity, d.summary.slice(0, 300)]);
  }

  /** Haqiqatan yopilgan bo'lsa DTO (ikki marta "tiklandi" yuborilmasin), aks holda null. */
  async resolve(id: string): Promise<CenterIncidentDto | null> {
    const rows: Row[] = await this.dataSource.query(
      `WITH u AS (UPDATE center_incidents SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING *)
       SELECT id, kind, severity, summary, opened_at, resolved_at FROM u`,
      [id],
    );
    return rows[0] ? toDto(rows[0]) : null;
  }

  async markNotified(id: string): Promise<void> {
    await this.dataSource.query(`UPDATE center_incidents SET notified_at = now() WHERE id = $1`, [id]);
  }

  /** Ochiq + oxirgi `sinceMs` ichida yopilganlar. */
  async recent(sinceMs: number, limit = 50): Promise<CenterIncidentDto[]> {
    const rows: Row[] = await this.dataSource.query(
      `SELECT id, kind, severity, summary, opened_at, resolved_at FROM center_incidents
        WHERE resolved_at IS NULL OR resolved_at >= $1 ORDER BY (resolved_at IS NULL) DESC, opened_at DESC LIMIT $2`,
      [new Date(sinceMs), limit],
    );
    return rows.map(toDto);
  }
}
