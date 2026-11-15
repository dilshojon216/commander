import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { CenterCheckDto, CenterHealthResponse } from '@commander/contracts';
import { TelegramService } from '../telegram/telegram.service.js';
import { formatCenterOpened, formatCenterResolved } from './center-alert-format.js';
import { CommandSignerService } from '../commands/command-signer.service.js';
import { Streak, checkBackup, checkDbDisk, checkProbe, checkRuntime, checkTelegram, planCenterIncidents, worstStatus } from './center-checks.js';
import type { CheckResult, Severity } from './center-checks.js';
import { CenterIncidentsService } from './center-incidents.service.js';
import type { CenterProbes } from './center-probes.js';
import { CENTER_HEALTH_OPTIONS, CENTER_PROBES } from './center-health.options.js';
import type { CenterHealthOptions } from './center-health.options.js';

const RECENT_MS = 24 * 3_600_000;

/**
 * Markaz o'z-o'zini kuzatishi (5.5): har `tickMs`da DB disk, zaxira, dashboard, Tailscale serve, jarayon (event-loop/xotira)
 * va Telegram polling tekshiriladi; hodisalar `center_incidents`ga yoziladi (ochilish = Telegram BIR marta, jiddiylashish =
 * qayta xabar, tiklanish = "Tiklandi"). agentd offline > 10 daqiqa 3.8'da (`HealthAlertsService`) bor: bu yerda takrorlanmaydi.
 * Telegram o'chiq/xato bo'lsa hodisa baribir saqlanadi va dashboard "Markaz holati" kartasi ko'rsatadi.
 */
@Injectable()
export class CenterHealthService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(CenterHealthService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CenterHealthResponse> | null = null;
  private last: { at: number; checks: CheckResult[] } | null = null;
  private readonly startedAt = Date.now();
  private readonly dashboardFails = new Streak();
  private readonly tailscaleFails = new Streak();
  private readonly lagStreak = new Streak();
  private readonly signerFails = new Streak();
  private diskLevel: Severity = 'ok';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly incidents: CenterIncidentsService,
    @Inject(CENTER_HEALTH_OPTIONS) private readonly options: CenterHealthOptions,
    @Inject(CENTER_PROBES) private readonly probes: CenterProbes,
    @Optional() private readonly telegram?: TelegramService,
    @Optional() private readonly signer?: CommandSignerService,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`center health tick failed: ${err instanceof Error ? err.message : String(err)}`)), this.options.tickMs);
    this.timer.unref();
    const first = setTimeout(() => void this.tick().catch(() => undefined), this.options.firstTickMs);
    first.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.probes.stop();
  }

  /** Bir vaqtda bitta tekshiruv (REST va taymer bir-biriga halaqit bermasin). */
  tick(now: number = Date.now()): Promise<CenterHealthResponse> {
    if (this.running) return this.running;
    const p = this.run(now).finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  /** REST: oxirgi natija (yo'q bo'lsa bir marta o'lchaydi). */
  async snapshot(now: number = Date.now()): Promise<CenterHealthResponse> {
    if (!this.last) return this.tick(now);
    return this.response(this.last.checks, this.last.at);
  }

  // --- o'lchash ----------------------------------------------------------------------------------

  private async measure(now: number): Promise<CheckResult[]> {
    const [dbBytes, backupMs, dashboardUp, tailscaleUp] = await Promise.all([
      this.dbBytes(),
      this.backupLastSuccessMs(),
      this.probes.http('dashboard').catch(() => false),
      this.probes.http('tailscale').catch(() => false),
    ]);
    const signerHealth = (await this.signer?.probe().catch(() => null)) ?? null;
    const signerState = { mode: signerHealth?.mode ?? ('file' as const), reachable: signerHealth?.reachable ?? null, locked: signerHealth?.locked ?? false, keyPresent: signerHealth?.keyPresent ?? true };
    if (signerState.mode === 'signer' && signerState.reachable !== null) this.signerFails.push(signerState.reachable === false);
    const disk = this.probes.disk();
    const runtime = this.probes.runtime();

    if (dashboardUp !== null) this.dashboardFails.push(dashboardUp === false);
    if (tailscaleUp !== null) this.tailscaleFails.push(tailscaleUp === false);
    const lagBad = runtime.lagP99Ms !== null && runtime.lagP99Ms >= 500;
    this.lagStreak.push(lagBad);

    const results: CheckResult[] = [
      checkDbDisk({ usedPct: disk?.usedPct ?? null, freeBytes: disk?.freeBytes ?? null, totalBytes: disk?.totalBytes ?? null, dbBytes, prev: this.diskLevel }),
      checkBackup({ lastSuccessMs: backupMs, nowMs: now, uptimeMs: now - this.startedAt }),
      checkProbe('dashboard', { configured: dashboardUp !== null, reachable: dashboardUp, failStreak: this.dashboardFails.count }, 'Dashboard'),
      checkProbe('tailscale', { configured: tailscaleUp !== null, reachable: tailscaleUp, failStreak: this.tailscaleFails.count }, 'Tailscale serve'),
      checkRuntime({ ...runtime, lagStreak: this.lagStreak.count, signer: { ...signerState, failStreak: this.signerFails.count } }),
      checkTelegram({ ...(this.telegram?.pollingStats() ?? { enabled: false, startedAt: null, lastOkAt: null }), nowMs: now }),
    ];
    const disc = results[0]!;
    this.diskLevel = disc.status === 'warn' || disc.status === 'critical' ? disc.status : disc.status === 'ok' ? 'ok' : this.diskLevel;
    return results;
  }

  private async dbBytes(): Promise<number | null> {
    try {
      const rows: Array<{ n: string }> = await this.dataSource.query(`SELECT pg_database_size(current_database())::text AS n`);
      return Number(rows[0]?.n ?? 0);
    } catch {
      return null;
    }
  }

  /** Zaxira skripti (`ops/mac/backup.sh`) muvaffaqiyatdan keyin `settings['backup.last_success']` ga `{ts}` yozadi (epoch soniya yoki ms). */
  private async backupLastSuccessMs(): Promise<number | null> {
    try {
      const rows: Array<{ value: { ts?: unknown } | null }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'backup.last_success'`);
      const ts = Number(rows[0]?.value?.ts);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return ts < 1e12 ? ts * 1000 : ts;
    } catch {
      return null;
    }
  }

  private async run(now: number): Promise<CenterHealthResponse> {
    const checks = await this.measure(now);
    this.last = { at: now, checks };
    await this.reconcile(checks, now);
    return this.response(checks, now);
  }

  // --- hodisalar ---------------------------------------------------------------------------------

  async reconcile(checks: readonly CheckResult[], now: number): Promise<void> {
    const plan = planCenterIncidents(await this.incidents.open(), checks);
    for (const d of plan.open) {
      const id = await this.incidents.create(d);
      if (id && (await this.send(formatCenterOpened(d)))) await this.incidents.markNotified(id);
    }
    for (const e of plan.escalate) {
      await this.incidents.update(e.id, e.desired);
      if (await this.send(formatCenterOpened(e.desired, true))) await this.incidents.markNotified(e.id);
    }
    for (const x of [...plan.downgrade, ...plan.refresh]) await this.incidents.update(x.id, x.desired);
    for (const r of plan.resolve) {
      const dto = await this.incidents.resolve(r.id);
      if (dto) {
        const text = checks.find((c) => c.kind === dto.kind)?.summary ?? dto.summary;
        await this.send(formatCenterResolved({ kind: dto.kind, severity: dto.severity, summary: text }, new Date(dto.openedAt), new Date(now)));
      }
    }
  }

  private async send(text: string): Promise<boolean> {
    if (!this.telegram) return false;
    try {
      return (await this.telegram.notifyText(text)) > 0;
    } catch (err) {
      this.logger.warn(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // --- javob -------------------------------------------------------------------------------------

  private async response(checks: readonly CheckResult[], at: number): Promise<CenterHealthResponse> {
    const [incidents, offline] = await Promise.all([
      this.incidents.recent(Date.now() - RECENT_MS),
      this.dataSource.query(`SELECT count(*)::text AS n FROM health_incidents WHERE kind = 'offline' AND resolved_at IS NULL`) as Promise<Array<{ n: string }>>,
    ]);
    const iso = new Date(at).toISOString();
    const dtos: CenterCheckDto[] = checks.map((c) => ({ kind: c.kind, status: c.status, summary: c.summary, metrics: c.metrics, checkedAt: iso }));
    return {
      checkedAt: iso,
      status: worstStatus(checks),
      checks: dtos,
      incidents,
      machinesOffline: Number(offline[0]?.n ?? 0),
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
