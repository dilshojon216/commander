import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BudgetsService } from '../budgets/budgets.service.js';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QUEUE_LIMITS } from '@commander/contracts';
import type { AgentControlState, CommandDto, CreateCommandBody, LimitsResponse } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { exhaustsWithin } from '../limits/forecast-logic.js';
import { LimitsService } from '../limits/limits.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { DEFER_MS, classifyCommand, decideFire, fireKey, nextAfterFire } from './queue-logic.js';
import type { RunOutcome } from './queue-logic.js';
import { QueueService } from './queue.service.js';
import { QUEUE_OPTIONS } from './queue.options.js';
import type { QueueOptions } from './queue.options.js';

/** `limit_exhausted` bo'yicha tekshiruv: 5 soatlik oyna shuncha ichida tugasa boshlanmaydi. */
const EXHAUST_GUARD_MS = 5 * 60_000;
/** Command yaratilmay qolgan (crash) `starting` ishga tushirish shundan keyin yo'qolgan hisoblanadi. */
const LOST_RUN_MS = 2 * 60_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Fired {
  itemId: string;
  runId: string;
  seq: number;
  creatorDeviceId: string;
  prompt: Buffer;
  body: CreateCommandBody;
}

/**
 * Navbat scheduler'i (bitta center jarayoni, tik 30 s, idempotent, restartdan omon qoladi: holat DB'da).
 *
 * Ishga tushirish: tranzaksiyada (qator `FOR UPDATE SKIP LOCKED`) `queue.fired` auditi + `task_queue_runs` qatori + holat
 * (fire_seq+1) yoziladi, KEYIN `CommandsService.create(session.start)` `Idempotency-Key = queue-<id>-<seq>` bilan, `system` aktori
 * va `confirmation='queue_item'` (yaratishdagi step-up allaqachon o'tgan) bilan chaqiriladi. Lockdown, lokal policy, imzo, rate limit
 * va `commands`/audit konveyeri oddiy `session.start` bilan bir xil. Crash: `starting` run + nonce bo'yicha buyruq qidiriladi.
 */
@Injectable()
export class QueueSchedulerService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: QueueService,
    private readonly commands: CommandsService,
    private readonly lockdown: LockdownService,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly bus: RealtimeBus,
    @Inject(QUEUE_OPTIONS) private readonly options: QueueOptions,
    /** 6.11: kunlik byudjet (qattiq chegarada element kutadi). Yo'q bo'lsa tekshirilmaydi. */
    @Optional() private readonly budgets?: BudgetsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((e) => {
      if (e.type === 'command.changed') return this.onCommandChanged(e.commandId);
      // L-22: qurilma revoke qilindi: uning faol navbat elementlari darhol bekor (fire-time tekshiruvi qo'shimcha to'r).
      if (e.type === 'device.event' && e.kind === 'revoked' && e.deviceId) return void this.cancelForRevokedDevice(e.deviceId).catch((err: unknown) => this.logger.error(`cancel on device revoke failed: ${errMsg(err)}`));
      return undefined;
    });
    if (this.options.tickMs <= 0) return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`queue tick failed: ${errMsg(err)}`)), this.options.tickMs);
    this.timer.unref();
    void this.tick().catch((err: unknown) => this.logger.error(`initial queue tick failed: ${errMsg(err)}`));
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Bitta tik. `false` = parallel tik ketayotgani uchun o'tkazib yuborildi. */
  async tick(now: Date = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.reconcileRuns(now);
      await this.armLimitResets(now);
      const due: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM task_queue WHERE status IN ('queued', 'waiting_trigger') AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 10`,
        [now],
      );
      let limitsView: LimitsResponse | null = null;
      for (const { id } of due) {
        limitsView ??= await this.limits.current(now).catch(() => null);
        await this.processItem(id, now, limitsView).catch((err: unknown) => this.logger.error(`queue item ${id} failed: ${errMsg(err)}`));
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  /** limit_reset elementlar: reset vaqti noma'lum bo'lsa (kuzatuv yo'q edi) bog'laydi. */
  private async armLimitResets(now: Date): Promise<void> {
    const rows: Array<{ id: string; window: '5h' | '7d' }> = await this.dataSource.query(
      `SELECT id, trigger->>'window' AS "window" FROM task_queue WHERE status = 'waiting_trigger' AND next_run_at IS NULL AND trigger->>'type' = 'limit_reset'`,
    );
    for (const r of rows) {
      const at = await this.queue.limitResetAt(r.window, now);
      if (!at) continue;
      await this.dataSource.query(`UPDATE task_queue SET next_run_at = $2, updated_at = $3 WHERE id = $1 AND next_run_at IS NULL`, [r.id, at, now]);
      this.bus.publish({ type: 'queue.changed', queueId: r.id });
    }
  }

  // --- ishga tushirish ---------------------------------------------------------------------------

  private async processItem(id: string, now: Date, limitsView: LimitsResponse | null): Promise<void> {
    const lockdownOn = (await this.lockdown.state()).enabled;
    const blockRows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'queue.block_when_limit_exhausted'`);
    const block = typeof blockRows[0]?.value === 'boolean' ? blockRows[0].value : this.options.blockWhenExhausted;
    const limitExhausted = block && exhaustsWithin(limitsView?.fiveHour, now, EXHAUST_GUARD_MS);

    const fired = await this.dataSource.transaction(async (m): Promise<Fired | null> => {
      const item = await this.queue.lockDue(m, id, now);
      if (!item) return null;
      // L-22: yaratgan qurilma revoke qilingan bo'lsa element ishga tushmaydi (bekor qilinadi, audit bilan).
      const creator: Array<{ revoked_at: Date | null }> = await m.query(`SELECT revoked_at FROM devices WHERE id = $1`, [item.created_by_device_id]);
      if (creator[0]?.revoked_at) {
        await m.query(`UPDATE task_queue SET status = 'cancelled', next_run_at = NULL, last_error = 'Cancelled: the creating device was revoked', last_error_code = 'creator_revoked', updated_at = $2 WHERE id = $1`, [id, now]);
        await this.audit.record({ actorDeviceId: null, actorKind: 'system', action: 'queue.cancelled', target: id, details: { reason: 'creator_revoked', created_by_device_id: item.created_by_device_id } }, m);
        return null;
      }
      const machines: Array<{ online: boolean; control: AgentControlState | null }> = await m.query(`SELECT online, control FROM machines WHERE id = $1`, [item.machine_id]);
      const machine = machines[0];
      const [{ active }] = (await m.query(`SELECT count(*)::int AS active FROM sessions WHERE machine_id = $1 AND started_by = 'remote' AND ended_at IS NULL`, [item.machine_id])) as Array<{ active: number }>;
      const [{ busy }] = (await m.query(`SELECT count(*)::int AS busy FROM sessions WHERE machine_id = $1 AND ended_at IS NULL AND status IN ('working', 'awaiting_approval')`, [item.machine_id])) as Array<{ busy: number }>;
      const [{ starting }] = (await m.query(`SELECT (SELECT count(*) FROM task_queue_runs WHERE status = 'starting')::int AS starting`)) as Array<{ starting: number }>;
      const isCron = item.trigger.type === 'cron';
      const decision = decideFire({
        lockdown: lockdownOn,
        machineOnline: machine?.online === true,
        activeRemote: active,
        maxConcurrent: machine?.control ? machine.control.maxConcurrentStarted : null,
        limitExhausted,
        attempts: item.attempts,
        maxAttempts: QUEUE_LIMITS.maxAttempts,
        isCron,
        machineBusy: busy > 0,
        triggerType: item.trigger.type,
        startingNow: starting,
        maxStartingNow: this.options.maxStartingNow,
        paceExceeded: limitsView?.pace?.blocked === true,
        budgetExceeded: this.budgets ? (await this.budgets.check(item.machine_id, item.cwd, now).catch(() => null)) !== null : false,
      });
      const actor = { actorDeviceId: null, actorKind: 'system' as const };

      if (decision.kind === 'defer') {
        await m.query(
          `UPDATE task_queue SET next_run_at = $2, attempts = attempts + $3, last_error = $4, last_error_code = $5, updated_at = $6 WHERE id = $1`,
          [id, new Date(now.getTime() + decision.delayMs), decision.countAttempt ? 1 : 0, `Deferred: ${decision.code}`, decision.code, now],
        );
        if (item.last_error_code !== decision.code) {
          await this.audit.record({ ...actor, action: 'queue.deferred', target: id, details: { reason: decision.code, trigger_type: item.trigger.type } }, m);
        }
        return null;
      }
      if (decision.kind === 'fail') {
        await m.query(`UPDATE task_queue SET status = 'failed', next_run_at = NULL, last_error = $2, last_error_code = $3, updated_at = $4 WHERE id = $1`, [id, `Failed: ${decision.code}`, decision.code, now]);
        await this.audit.record({ ...actor, action: 'queue.failed', target: id, details: { reason: decision.code } }, m);
        return null;
      }
      if (decision.kind === 'skip_occurrence') {
        const seq = item.fire_seq + 1;
        const next = item.trigger.type === 'cron' ? nextAfterFire(item.trigger, now) : null;
        await m.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, fired_at, status, error_code, finished_at) VALUES ($1, $2, $3, 'skipped', $4, $3)`, [id, seq, now, decision.code]);
        await m.query(`UPDATE task_queue SET fire_seq = $2, next_run_at = $3, attempts = 0, last_error = $4, last_error_code = $5, updated_at = $6 WHERE id = $1`, [id, seq, next, `Skipped: ${decision.code}`, decision.code, now]);
        await this.audit.record({ ...actor, action: 'queue.skipped', target: id, details: { reason: decision.code, fire_seq: seq } }, m);
        return null;
      }

      // fire: audit + run + holat BIR tranzaksiyada, buyruq yaratishdan OLDIN
      const seq = item.fire_seq + 1;
      const runs: Array<{ id: string }> = await m.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, fired_at, status) VALUES ($1, $2, $3, 'starting') RETURNING id`, [id, seq, now]);
      const runId = runs[0]!.id;
      const next = item.trigger.type === 'cron' ? nextAfterFire(item.trigger, now) : null;
      await m.query(
        `UPDATE task_queue SET fire_seq = $2, status = $3, next_run_at = $4, last_error = NULL, last_error_code = NULL, updated_at = $5 WHERE id = $1`,
        [id, seq, isCron ? 'waiting_trigger' : 'starting', next, now],
      );
      await this.audit.record(
        {
          ...actor,
          action: 'queue.fired',
          target: id,
          details: {
            run_id: runId,
            fire_seq: seq,
            trigger_type: item.trigger.type,
            machine_id: item.machine_id,
            creation_audit_id: item.creation_audit_id,
            creation_confirmation: item.confirmation,
            confirmed_at: item.confirmed_at.toISOString(),
            created_by_device_id: item.created_by_device_id,
            prompt_length: item.prompt_len,
          },
        },
        m,
      );
      return {
        itemId: id,
        runId,
        seq,
        creatorDeviceId: item.created_by_device_id,
        prompt: item.prompt_enc,
        body: { type: 'session.start', machineId: item.machine_id, cwd: item.cwd, prompt: '', permissionMode: item.permission_mode, ...(item.model ? { model: item.model } : {}), ...(item.name ? { name: item.name } : {}) },
      };
    });
    this.bus.publish({ type: 'queue.changed', queueId: id });
    if (!fired) return;

    let dto: CommandDto;
    try {
      const prompt = this.queue.decrypt(fired.itemId, fired.prompt);
      const actor: CommandActor = { deviceId: fired.creatorDeviceId, actorKind: 'system', ip: null, confirmation: 'queue_item' };
      const res = await this.commands.create({ ...fired.body, prompt } as CreateCommandBody, actor, fireKey(fired.itemId, fired.seq), now);
      dto = res.command;
    } catch (err) {
      await this.settleRun(fired.runId, this.outcomeForError(err), null, null, now);
      return;
    }
    await this.dataSource.query(`UPDATE task_queue_runs SET command_id = $2 WHERE id = $1`, [fired.runId, dto.id]);
    await this.dataSource.query(`UPDATE task_queue SET last_command_id = $2 WHERE id = $1`, [id, dto.id]);
    await this.settleFromCommand(fired.runId, dto, now);
  }

  private outcomeForError(err: unknown): RunOutcome {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const resp = err.getResponse();
      const obj = typeof resp === 'object' && resp !== null ? (resp as Record<string, unknown>) : {};
      const code = typeof obj['error'] === 'string' ? obj['error'] : `http_${status}`;
      if (status === 403) return { kind: 'retry', code: 'lockdown' };
      if (status === 429 || status === 409) return { kind: 'retry', code };
      return { kind: 'failed', code };
    }
    this.logger.error(`queue fire failed: ${errMsg(err)}`);
    return { kind: 'failed', code: 'internal_error' };
  }

  // --- natijani qo'llash -------------------------------------------------------------------------

  private async settleFromCommand(runId: string, dto: CommandDto, now: Date): Promise<void> {
    const outcome = classifyCommand(dto.status, dto.errorCode);
    if (outcome.kind === 'pending') return;
    await this.settleRun(runId, outcome, dto.sessionId, dto.errorMessage, now);
  }

  /** Run yakunlanadi; element holati (bir martalik) yoki keyingi urinish (retry) belgilanadi. Idempotent: faqat `starting` run. */
  async settleRun(runId: string, outcome: RunOutcome, sessionId: string | null, message: string | null, now: Date): Promise<void> {
    if (outcome.kind === 'pending') return;
    const queueId = await this.dataSource.transaction(async (m): Promise<string | null> => {
      const runs: Array<{ queue_id: string; status: string }> = await m.query(`SELECT queue_id, status FROM task_queue_runs WHERE id = $1 FOR UPDATE`, [runId]);
      const run = runs[0];
      if (!run || run.status !== 'starting') return null;
      const items: Array<{ status: string; trigger: { type: string }; attempts: number }> = await m.query(`SELECT status, trigger, attempts FROM task_queue WHERE id = $1 FOR UPDATE`, [run.queue_id]);
      const item = items[0];
      if (!item) return null;
      const isCron = item.trigger.type === 'cron';
      const err = message ? message.slice(0, 500) : null;
      const actor = { actorDeviceId: null, actorKind: 'system' as const };

      if (outcome.kind === 'started') {
        await m.query(`UPDATE task_queue_runs SET status = 'started', session_id = $2, finished_at = $3 WHERE id = $1`, [runId, sessionId, now]);
        await m.query(
          `UPDATE task_queue SET status = CASE WHEN $3::boolean THEN status ELSE 'started' END, last_session_id = COALESCE($2::uuid, last_session_id), attempts = 0, updated_at = $4 WHERE id = $1`,
          [run.queue_id, sessionId, isCron, now],
        );
        await this.audit.record({ ...actor, action: 'queue.started', target: run.queue_id, details: { run_id: runId, session_id: sessionId } }, m);
        return run.queue_id;
      }
      await m.query(`UPDATE task_queue_runs SET status = 'failed', error_code = $2, finished_at = $3 WHERE id = $1`, [runId, outcome.code, now]);
      if (outcome.kind === 'retry' && item.attempts + 1 < QUEUE_LIMITS.maxAttempts) {
        await m.query(
          `UPDATE task_queue SET status = 'waiting_trigger', next_run_at = $2, attempts = attempts + 1, last_error = $3, last_error_code = $4, updated_at = $5 WHERE id = $1`,
          [run.queue_id, new Date(now.getTime() + DEFER_MS.offline), err ?? `Retry: ${outcome.code}`, outcome.code, now],
        );
        await this.audit.record({ ...actor, action: 'queue.retry', target: run.queue_id, details: { run_id: runId, reason: outcome.code } }, m);
        return run.queue_id;
      }
      // policy rad etdi (yoki urinishlar tugadi): bir martalik => failed (sabab bilan); takroriy => keyingi chiqishga qoladi
      await m.query(
        `UPDATE task_queue SET status = CASE WHEN $2::boolean THEN status ELSE 'failed' END, last_error = $3, last_error_code = $4, updated_at = $5 WHERE id = $1`,
        [run.queue_id, isCron, err ?? `Failed: ${outcome.code}`, outcome.code, now],
      );
      await this.audit.record({ ...actor, action: 'queue.failed', target: run.queue_id, details: { run_id: runId, reason: outcome.code } }, m);
      return run.queue_id;
    });
    if (queueId) this.bus.publish({ type: 'queue.changed', queueId });
  }

  /** Ochiq run'larni buyruq holatiga moslaydi (tik va `command.changed`). Restartdan keyin ham ishlaydi. */
  async reconcileRuns(now: Date): Promise<void> {
    const runs: Array<{ id: string; queue_id: string; command_id: string | null; fired_at: Date; fire_seq: number; device: string }> = await this.dataSource.query(
      `SELECT r.id, r.queue_id, r.command_id, r.fired_at, r.fire_seq, q.created_by_device_id AS device
         FROM task_queue_runs r JOIN task_queue q ON q.id = r.queue_id WHERE r.status = 'starting' ORDER BY r.fired_at LIMIT 50`,
    );
    for (const r of runs) {
      let commandId = r.command_id;
      if (!commandId) {
        const found: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM commands WHERE requested_by_device_id = $1 AND nonce = $2`, [r.device, fireKey(r.queue_id, r.fire_seq)]);
        commandId = found[0]?.id ?? null;
        if (commandId) await this.dataSource.query(`UPDATE task_queue_runs SET command_id = $2 WHERE id = $1`, [r.id, commandId]);
      }
      if (!commandId) {
        if (now.getTime() - r.fired_at.getTime() >= LOST_RUN_MS) await this.settleRun(r.id, { kind: 'retry', code: 'center_restarted' }, null, 'The center restarted before the command was created', now);
        continue;
      }
      await this.settleFromCommand(r.id, await this.commands.getDto(commandId), now);
    }
  }

  /** L-22: revoke qilingan qurilma yaratgan faol (queued|waiting_trigger) elementlarni bekor qiladi. Bekor qilingan id'lar. */
  async cancelForRevokedDevice(deviceId: string, now: Date = new Date()): Promise<string[]> {
    const ids = await this.dataSource.transaction(async (m): Promise<string[]> => {
      // TypeORM: UPDATE ... RETURNING -> [rows, affectedCount]
      const [rows] = (await m.query(
        `UPDATE task_queue SET status = 'cancelled', next_run_at = NULL, last_error = 'Cancelled: the creating device was revoked', last_error_code = 'creator_revoked', updated_at = $2
          WHERE created_by_device_id = $1 AND status IN ('queued', 'waiting_trigger') RETURNING id`,
        [deviceId, now],
      )) as [Array<{ id: string }>, number];
      for (const r of rows) await this.audit.record({ actorDeviceId: null, actorKind: 'system', action: 'queue.cancelled', target: r.id, details: { reason: 'creator_revoked', created_by_device_id: deviceId } }, m);
      return rows.map((r) => r.id);
    });
    for (const id of ids) this.bus.publish({ type: 'queue.changed', queueId: id });
    return ids;
  }

  private async onCommandChanged(commandId: string): Promise<void> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM task_queue_runs WHERE command_id = $1 AND status = 'starting'`, [commandId]);
    for (const r of rows) await this.settleFromCommand(r.id, await this.commands.getDto(commandId), new Date());
  }
}
