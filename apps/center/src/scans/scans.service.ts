import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_SCAN_SETTINGS, SCAN_LIMITS, ScanCountsSchema, ScanFindingSchema, ScanSettingsSchema, ScanToolRunSchema, emptyCounts } from '@commander/contracts';
import type { PutScanSettingsBody, ProjectScanSummary, RunScanResponse, ScanCounts, ScanDetail, ScanHistoryResponse, ScanListResponse, ScanSettings, ScanTrendPoint } from '@commander/contracts';
import { z } from 'zod';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { nextDue, parseSchedule } from './scan-logic.js';
import type { ScheduleState } from './scan-logic.js';

export const SCAN_SETTINGS_KEY = 'scans.settings';
export const SCAN_SCHEDULE_KEY = 'scans.schedule';

interface ScanRow {
  id: string;
  project_id: string;
  machine_id: string;
  command_id: string | null;
  scanned_at: Date;
  counts: unknown;
  vuln_count: number;
  outdated_count: number;
  secret_count: number;
  env_file_count: number;
  ecosystems: string[];
  tools: unknown;
  findings: unknown;
  findings_total: number;
  truncated: boolean;
  files_scanned: number;
  duration_ms: number;
  partial: boolean;
  project_name: string;
  project_key: string;
  machine_name: string;
}

interface TrendRow {
  project_id: string;
  scanned_at: Date;
  counts: unknown;
  secret_count: number;
  outdated_count: number;
}

const BASE = `
  SELECT s.*, p.name AS project_name, COALESCE(p.repo_key, p.id::text) AS project_key, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name
    FROM project_scans s
    JOIN projects p ON p.id = s.project_id
    JOIN machines m ON m.id = s.machine_id`;

const parseCounts = (v: unknown): ScanCounts => {
  const r = ScanCountsSchema.safeParse(v);
  return r.success ? r.data : emptyCounts();
};

function toTrend(rows: TrendRow[]): ScanTrendPoint[] {
  return rows
    .map((r) => {
      const c = parseCounts(r.counts);
      return { at: r.scanned_at.toISOString(), critical: c.critical, high: c.high, moderate: c.moderate, low: c.low, secrets: r.secret_count, outdated: r.outdated_count };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

function toSummary(r: ScanRow, trend: TrendRow[]): ProjectScanSummary {
  return {
    scanId: r.id,
    projectId: r.project_id,
    projectKey: r.project_key,
    projectName: r.project_name,
    machineId: r.machine_id,
    machineName: r.machine_name,
    scannedAt: r.scanned_at.toISOString(),
    counts: parseCounts(r.counts),
    vulnCount: r.vuln_count,
    outdatedCount: r.outdated_count,
    secretCount: r.secret_count,
    envFileCount: r.env_file_count,
    ecosystems: r.ecosystems,
    partial: r.partial,
    trend: toTrend(trend),
  };
}

export async function readJsonSetting(ds: DataSource, key: string): Promise<unknown> {
  const rows: Array<{ value: unknown }> = await ds.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0]?.value;
}

export async function writeJsonSetting(ds: DataSource, key: string, value: unknown): Promise<void> {
  await ds.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

/** Xavfsizlik tekshiruvi (6.10): o'qish, "Hozir tekshirish", sozlamalar. Ishga tushirish hamma joyda `commands` konveyeri orqali. */
@Injectable()
export class ScansService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
  ) {}

  async getSettings(): Promise<ScanSettings> {
    const r = ScanSettingsSchema.safeParse(await readJsonSetting(this.dataSource, SCAN_SETTINGS_KEY));
    return r.success ? r.data : { ...DEFAULT_SCAN_SETTINGS };
  }

  async putSettings(body: PutScanSettingsBody, actor: CommandActor): Promise<ScanSettings> {
    await this.dataSource.transaction(async (m) => {
      await m.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SCAN_SETTINGS_KEY, JSON.stringify(body)]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'scan.settings', target: SCAN_SETTINGS_KEY, ip: actor.ip ?? null, details: { enabled: body.enabled, digest: body.digest } }, m);
    });
    return body;
  }

  async getSchedule(): Promise<ScheduleState> {
    return parseSchedule(await readJsonSetting(this.dataSource, SCAN_SCHEDULE_KEY));
  }

  async list(now: Date = new Date()): Promise<ScanListResponse> {
    const [settings, schedule] = await Promise.all([this.getSettings(), this.getSchedule()]);
    const latest: ScanRow[] = await this.dataSource.query(`${BASE} WHERE s.id IN (SELECT DISTINCT ON (project_id) id FROM project_scans ORDER BY project_id, scanned_at DESC) ORDER BY s.scanned_at DESC`);
    const trend: TrendRow[] =
      latest.length === 0
        ? []
        : await this.dataSource.query(
            `SELECT project_id, scanned_at, counts, secret_count, outdated_count
               FROM (SELECT project_id, scanned_at, counts, secret_count, outdated_count, row_number() OVER (PARTITION BY project_id ORDER BY scanned_at DESC) AS rn
                       FROM project_scans WHERE project_id = ANY($1::uuid[])) t WHERE rn <= $2`,
            [latest.map((r) => r.project_id), SCAN_LIMITS.trendPoints],
          );
    return {
      projects: latest.map((r) =>
        toSummary(
          r,
          trend.filter((t) => t.project_id === r.project_id),
        ),
      ),
      settings,
      nextRunAt: settings.enabled ? nextDue(now).toISOString() : null,
      lastRunAt: schedule.runStartedAt,
    };
  }

  async detail(scanId: string): Promise<ScanDetail> {
    const rows: ScanRow[] = await this.dataSource.query(`${BASE} WHERE s.id = $1`, [scanId]);
    const r = rows[0];
    if (!r) throw new NotFoundException({ error: 'not_found', message: 'Scan not found' });
    const trend: TrendRow[] = await this.dataSource.query(
      `SELECT project_id, scanned_at, counts, secret_count, outdated_count FROM project_scans WHERE project_id = $1 ORDER BY scanned_at DESC LIMIT $2`,
      [r.project_id, SCAN_LIMITS.trendPoints],
    );
    return {
      ...toSummary(r, trend),
      tools: z.array(ScanToolRunSchema).catch([]).parse(r.tools),
      findings: z.array(ScanFindingSchema).catch([]).parse(r.findings),
      findingsTotal: r.findings_total,
      truncated: r.truncated,
      filesScanned: r.files_scanned,
      durationMs: r.duration_ms,
      commandId: r.command_id,
    };
  }

  async history(projectId: string, limit = 30): Promise<ScanHistoryResponse> {
    const exists: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (exists.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    const rows: ScanRow[] = await this.dataSource.query(`${BASE} WHERE s.project_id = $1 ORDER BY s.scanned_at DESC LIMIT $2`, [projectId, Math.min(Math.max(limit, 1), SCAN_LIMITS.keepPerProject)]);
    return {
      scans: rows.map((r) => ({
        scanId: r.id,
        scannedAt: r.scanned_at.toISOString(),
        counts: parseCounts(r.counts),
        vulnCount: r.vuln_count,
        outdatedCount: r.outdated_count,
        secretCount: r.secret_count,
        envFileCount: r.env_file_count,
        partial: r.partial,
      })),
    };
  }

  /** "Hozir tekshirish": `project.scan` buyrug'i (imzolangan, audit, lokal siyosat). Natija `command.updated` + `project_scans`. */
  async run(projectId: string, actor: CommandActor, idempotencyKey?: string): Promise<RunScanResponse> {
    const res = await this.commands.create({ type: 'project.scan', projectId }, actor, idempotencyKey);
    const c = res.command;
    // Darhol rad etilgan (oflayn, eski agentd, lokal siyosat, byudjet...): klient aniq xato kodi bilan ko'radi
    if (c.status === 'rejected' || c.status === 'failed' || c.status === 'expired') {
      throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, 409);
    }
    return { commandId: c.id, status: c.status, errorCode: null, errorMessage: null };
  }
}
