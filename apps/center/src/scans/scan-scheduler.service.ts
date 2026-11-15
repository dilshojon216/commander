import { Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ScanFinding } from '@commander/contracts';
import { ScanFindingSchema, ScanCountsSchema, emptyCounts } from '@commander/contracts';
import { z } from 'zod';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { formatScanDigest } from './scan-format.js';
import { decideSchedule, tashkentDate } from './scan-logic.js';
import type { DigestRow, ScheduleAction } from './scan-logic.js';
import { SCAN_SCHEDULE_KEY, ScansService, writeJsonSetting } from './scans.service.js';

export const SCAN_TICK_MS = 60_000;
/** Bitta skan buyrug'ini kutish (agentd muddati 270 s + zaxira). */
const SCAN_WAIT_MS = 330_000;

export interface ScanTarget {
  projectId: string;
  machineId: string;
}

/** Haftalik tekshiruv rejalashtiruvchisi (6.10): yakshanba 06:00 Toshkent, mashina bo'yicha ketma-ket, so'ng Telegram dayjest. */
@Injectable()
export class ScanSchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ScanSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scans: ScansService,
    private readonly commands: CommandsService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['VITEST'] || process.env['SCANS_SCHEDULER_DISABLED'] === '1') return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`scan tick failed: ${err instanceof Error ? err.message : String(err)}`)), SCAN_TICK_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Bitta tik (testlar uchun ochiq): qaror qaytariladi; `run` fon rejimida davom etadi (`awaitRun` bilan kutiladi). */
  async tick(now: Date = new Date(), awaitRun = false): Promise<ScheduleAction> {
    const [settings, state] = await Promise.all([this.scans.getSettings(), this.scans.getSchedule()]);
    const action = decideSchedule({ now, enabled: settings.enabled, digest: settings.digest, state, running: this.running });
    if (action.kind === 'init') {
      await writeJsonSetting(this.dataSource, SCAN_SCHEDULE_KEY, { dueKey: action.dueKey, runStartedAt: state.runStartedAt, digestPending: false });
    } else if (action.kind === 'run') {
      // `now` faqat qaror uchun (testda siljitiladi); skan oynasi haqiqiy soat bilan: `project_scans.scanned_at = now()` (DB soati)
      const startedAt = new Date();
      await writeJsonSetting(this.dataSource, SCAN_SCHEDULE_KEY, { dueKey: action.dueKey, runStartedAt: startedAt.toISOString(), digestPending: settings.digest });
      this.running = true;
      const p = this.runAll(action.dueKey, startedAt, settings.digest).catch((err: unknown) => this.logger.error(`weekly scan failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => {
        this.running = false;
      });
      if (awaitRun) await p;
    } else if (action.kind === 'digest' && state.runStartedAt) {
      await this.sendDigest(new Date(state.runStartedAt), 0);
      await writeJsonSetting(this.dataSource, SCAN_SCHEDULE_KEY, { ...state, digestPending: false });
    }
    return action;
  }

  /** Skan qilinadigan loyihalar: har repo guruhi BIR marta (eng yangi faol mashinada), onlayn va `scan` e'lon qilgan mashinalarda. */
  async targets(): Promise<ScanTarget[]> {
    const rows: Array<{ project_id: string; machine_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ON (COALESCE(p.repo_key, p.id::text)) p.id AS project_id, p.machine_id
         FROM projects p
         JOIN machines m ON m.id = p.machine_id AND m.status = 'active' AND m.merged_into_id IS NULL AND m.online = true
        WHERE (m.control->>'scan') = 'true' AND COALESCE(m.control->>'allowScan', 'true') <> 'false'
          AND COALESCE(p.last_snapshot_at, p.created_at) > now() - interval '45 days'
        ORDER BY COALESCE(p.repo_key, p.id::text), p.last_snapshot_at DESC NULLS LAST`,
    );
    return rows.map((r) => ({ projectId: r.project_id, machineId: r.machine_id }));
  }

  /** Tizim aktori uchun qurilma: eng oxirgi faol klient qurilma (dashboard/Telegram/menubar/mobil); yo'q bo'lsa `null` (skan o'tkazilmaydi). */
  async ownerDeviceId(): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM devices WHERE revoked_at IS NULL AND kind <> 'agentd' ORDER BY last_used_at DESC NULLS LAST LIMIT 1`);
    return rows[0]?.id ?? null;
  }

  async runAll(dueKey: string, startedAt: Date, digest: boolean): Promise<{ total: number; failed: number }> {
    const deviceId = await this.ownerDeviceId();
    const targets = deviceId ? await this.targets() : [];
    if (!deviceId) this.logger.warn('weekly scan skipped: no active client device to act as the requester');
    const actor: CommandActor = { deviceId: deviceId ?? '', actorKind: 'system', ip: null };
    const byMachine = new Map<string, ScanTarget[]>();
    for (const t of targets) byMachine.set(t.machineId, [...(byMachine.get(t.machineId) ?? []), t]);
    let failed = 0;
    // mashinalar parallel, har mashinada ketma-ket (agentd ham bittadan bajaradi)
    await Promise.all(
      [...byMachine.values()].map(async (list) => {
        for (const t of list) {
          try {
            const created = await this.commands.create({ type: 'project.scan', projectId: t.projectId }, actor, `scan-${dueKey}-${t.projectId}`.slice(0, 128));
            const fin = await this.commands.waitFinished(created.command.id, SCAN_WAIT_MS);
            if (fin.timedOut || fin.command.status !== 'done') failed++;
          } catch (err) {
            failed++;
            this.logger.warn(`scan ${t.projectId} not started: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );
    if (digest) {
      await this.sendDigest(startedAt, failed);
      await writeJsonSetting(this.dataSource, SCAN_SCHEDULE_KEY, { dueKey, runStartedAt: startedAt.toISOString(), digestPending: false });
    }
    return { total: targets.length, failed };
  }

  async digestRows(since: Date): Promise<DigestRow[]> {
    const rows: Array<{ counts: unknown; secret_count: number; vuln_count: number; outdated_count: number; partial: boolean; findings: unknown; project_name: string; machine_name: string }> =
      await this.dataSource.query(
        `SELECT s.counts, s.secret_count, s.vuln_count, s.outdated_count, s.partial, s.findings, p.name AS project_name, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name
           FROM project_scans s JOIN projects p ON p.id = s.project_id JOIN machines m ON m.id = s.machine_id
          WHERE s.id IN (SELECT DISTINCT ON (project_id) id FROM project_scans WHERE scanned_at >= $1 ORDER BY project_id, scanned_at DESC)`,
        [since],
      );
    return rows.map((r) => ({
      projectName: r.project_name,
      machineName: r.machine_name,
      counts: ScanCountsSchema.catch(emptyCounts()).parse(r.counts),
      secretCount: r.secret_count,
      vulnCount: r.vuln_count,
      outdatedCount: r.outdated_count,
      partial: r.partial,
      top: z.array(ScanFindingSchema).catch([] as ScanFinding[]).parse(r.findings),
    }));
  }

  /** Telegram dayjest (faqat critical/high + sonlar). Bot o'chiq bo'lsa jim. */
  async sendDigest(since: Date, failed: number): Promise<number> {
    if (!this.telegram) return 0;
    const parts = formatScanDigest(await this.digestRows(since), { date: tashkentDate(new Date()), failed });
    let delivered = 0;
    for (const part of parts) delivered = Math.max(delivered, await this.telegram.notifyText(part));
    return delivered;
  }
}
