import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { QUEUE_LIMITS } from '@commander/contracts';
import type {
  AgentControlState,
  CreateQueueItemBody,
  ListQueueQuery,
  ListQueueResponse,
  QueueDetailResponse,
  QueueItemDto,
  QueueRunDto,
  QueueStatus,
  QueueTrigger,
  UpdateQueueItemBody,
} from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { LimitsService } from '../limits/limits.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { decryptPrompt, encryptPrompt, loadOrCreateQueueKey } from './queue-crypto.js';
import { LIMIT_RESET_SLACK_MS, TriggerError, confirmationFor, scheduleFor } from './queue-logic.js';
import type { QueueConfirmation } from './queue-logic.js';
import { QUEUE_OPTIONS } from './queue.options.js';
import type { QueueOptions } from './queue.options.js';
import { nextCronRun } from './cron.js';

export interface QueueActor {
  deviceId: string;
  actorKind: AuditActorKind;
  ip: string | null;
  /** `telegram_inline`: Telegram chatida yakuniy xulosa kartasidagi aniq tasdiq. Faqat `actorKind='telegram'` uchun hisobga olinadi; REST uni o'rnatmaydi. */
  confirmation?: 'telegram_inline';
  /** 3.9: orkestratsiya egasi tasdig'i qadam dispatch'ini qoplaydi (faqat `system` aktori; REST/Telegram uni o'rnatmaydi). */
  orchestrationConfirmation?: QueueConfirmation;
}

export interface QueueRow {
  id: string;
  project_id: string | null;
  machine_id: string;
  machine_slug: string;
  cwd: string;
  prompt_len: number;
  prompt_preview: string;
  model: string | null;
  permission_mode: QueueItemDto['permissionMode'];
  name: string | null;
  task_key: string | null;
  trigger: QueueTrigger;
  status: QueueStatus;
  attempts: number;
  last_error: string | null;
  last_error_code: string | null;
  created_by_device_id: string;
  confirmation: QueueConfirmation;
  confirmed_at: Date;
  created_at: Date;
  updated_at: Date;
  next_run_at: Date | null;
  last_session_id: string | null;
  last_command_id: string | null;
  run_count: number;
  last_run_at: Date | null;
}

const SELECT_DTO = `
  SELECT q.id, q.project_id, q.machine_id, m.slug AS machine_slug, q.cwd, q.prompt_len, q.prompt_preview, q.model, q.permission_mode,
         q.name, q.task_key, q.trigger, q.status, q.attempts, q.last_error, q.last_error_code, q.created_by_device_id, q.confirmation,
         q.confirmed_at, q.created_at, q.updated_at, q.next_run_at, q.last_session_id, q.last_command_id,
         (SELECT count(*)::int FROM task_queue_runs r WHERE r.queue_id = q.id AND r.status <> 'skipped') AS run_count,
         (SELECT max(r.fired_at) FROM task_queue_runs r WHERE r.queue_id = q.id AND r.status <> 'skipped') AS last_run_at
    FROM task_queue q JOIN machines m ON m.id = q.machine_id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const PREVIEW_CHARS = 300;

/** DB qatori -> API. Prompt (shifrlangan yoki ochiq) bu yerga HECH QACHON kirmaydi: faqat redakt qilingan ko'rinish. */
export function toQueueDto(r: QueueRow): QueueItemDto {
  return {
    id: r.id,
    projectId: r.project_id,
    machineId: r.machine_id,
    machineSlug: r.machine_slug,
    cwd: r.cwd,
    promptPreview: r.prompt_preview.length > PREVIEW_CHARS ? `${r.prompt_preview.slice(0, PREVIEW_CHARS)}…` : r.prompt_preview,
    promptLength: r.prompt_len,
    model: r.model,
    permissionMode: r.permission_mode,
    name: r.name,
    taskKey: r.task_key,
    trigger: r.trigger,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    lastErrorCode: r.last_error_code,
    createdByDeviceId: r.created_by_device_id,
    confirmation: r.confirmation,
    confirmedAt: r.confirmed_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    nextRunAt: iso(r.next_run_at),
    lastSessionId: r.last_session_id,
    lastCommandId: r.last_command_id,
    runCount: r.run_count,
    lastRunAt: iso(r.last_run_at),
  };
}

const ACTIVE = `('queued', 'waiting_trigger', 'starting')`;

/**
 * Vazifalar navbati (3.1). Yaratish = `session.start` bilan BIR XIL step-up qoidasi (`confirmationFor`); tasdiq elementda
 * saqlanadi (`confirmation`, `confirmed_at`, `creation_audit_id`). Ishga tushirish `QueueSchedulerService` da (system aktori).
 * Prompt FAQAT shifrlangan saqlanadi (`queue-crypto.ts`), API'da redakt qilingan ko'rinish.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private readonly key: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    private readonly limits: LimitsService,
    @Inject(QUEUE_OPTIONS) readonly options: QueueOptions,
  ) {
    this.key = loadOrCreateQueueKey(options.keyFile);
  }

  /** Scheduler uchun: promptni ochadi (log/xatoga tushmaydi). */
  decrypt(itemId: string, blob: Buffer): string {
    return decryptPrompt(this.key, itemId, blob);
  }

  async isStepUpExempt(deviceId: string): Promise<boolean> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    const v = rows[0]?.value;
    return Array.isArray(v) && v.includes(deviceId);
  }

  // --- yaratish / o'zgartirish -------------------------------------------------------------------

  async create(body: CreateQueueItemBody, actor: QueueActor, now: Date = new Date()): Promise<QueueItemDto> {
    const confirmation = await this.requireConfirmation(body.permissionMode, actor);

    const machines: Array<{ id: string; control: AgentControlState | null }> = await this.dataSource.query(
      `SELECT id, control FROM machines WHERE id = $1 AND status = 'active' AND merged_into_id IS NULL`,
      [body.machineId],
    );
    const machine = machines[0];
    if (!machine) throw new NotFoundException({ error: 'not_found', message: 'Machine not found' });
    if (machine.control && (!machine.control.enabled || !machine.control.allowStart)) {
      throw new HttpException({ error: 'policy_disabled', message: 'Remote start is not allowed by this machine\'s local policy' }, 422);
    }
    if (body.projectId) {
      const p: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1 AND machine_id = $2`, [body.projectId, body.machineId]);
      if (p.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found on this machine' });
    }

    const trigger = await this.normalizeTrigger(body.trigger, now);
    const schedule = await this.schedule(trigger, now);
    const id = randomUUID();
    const enc = encryptPrompt(this.key, id, body.prompt);

    await this.dataSource.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('task_queue'))`);
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM task_queue WHERE status IN ${ACTIVE}`)) as Array<{ n: number }>;
      if (n >= QUEUE_LIMITS.maxItems) throw new ConflictException({ error: 'queue_full', message: 'Too many queued items' });
      if (trigger.type === 'cron') {
        const [{ c }] = (await m.query(`SELECT count(*)::int AS c FROM task_queue WHERE status IN ${ACTIVE} AND trigger->>'type' = 'cron'`)) as Array<{ c: number }>;
        if (c >= QUEUE_LIMITS.maxActiveCron) throw new ConflictException({ error: 'too_many_recurring', message: 'Too many recurring items' });
      }
      await m.query(
        `INSERT INTO task_queue
           (id, project_id, machine_id, cwd, prompt_enc, prompt_len, prompt_preview, model, permission_mode, name, task_key, trigger,
            status, created_by_device_id, confirmation, confirmed_at, next_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $16, $16)`,
        [
          id, body.projectId ?? null, body.machineId, body.cwd, enc, body.prompt.length, redactAndCap(body.prompt, PREVIEW_CHARS),
          body.model ?? null, body.permissionMode, body.name ?? null, body.taskKey ?? null, JSON.stringify(trigger),
          schedule.status, actor.deviceId, confirmation, now, schedule.nextRunAt,
        ],
      );
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'queue.created',
          target: id,
          ip: actor.ip,
          details: {
            machine_id: body.machineId,
            permission_mode: body.permissionMode,
            trigger_type: trigger.type,
            confirmation,
            prompt_length: body.prompt.length,
            ...(body.projectId ? { project_id: body.projectId } : {}),
          },
        },
        m,
      );
      const a: Array<{ id: string }> = await m.query(`SELECT id::text AS id FROM audit_log WHERE action = 'queue.created' AND target = $1 ORDER BY id DESC LIMIT 1`, [id]);
      await m.query(`UPDATE task_queue SET creation_audit_id = $2::bigint WHERE id = $1`, [id, a[0]?.id ?? null]);
    });
    this.bus.publish({ type: 'queue.changed', queueId: id });
    return this.getDto(id);
  }

  async update(id: string, body: UpdateQueueItemBody, actor: QueueActor, now: Date = new Date()): Promise<QueueItemDto> {
    const cur = await this.getRow(id);
    if (cur.status !== 'queued' && cur.status !== 'waiting_trigger') throw new ConflictException({ error: 'queue_not_editable', message: `Item is ${cur.status}` });
    let confirmation: QueueConfirmation | null = null;
    // Prompt o'zgarsa: nima bajarilishi o'zgaradi => yaratishdagi kabi qayta step-up.
    if (body.prompt !== undefined) confirmation = await this.requireConfirmation(cur.permission_mode, actor);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown): void => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.prompt !== undefined) {
      add('prompt_enc', encryptPrompt(this.key, id, body.prompt));
      add('prompt_len', body.prompt.length);
      add('prompt_preview', redactAndCap(body.prompt, PREVIEW_CHARS));
      add('confirmation', confirmation);
      add('confirmed_at', now);
    }
    if (body.model !== undefined) add('model', body.model);
    if (body.name !== undefined) add('name', body.name);
    if (body.trigger !== undefined) {
      const trigger = await this.normalizeTrigger(body.trigger, now);
      const schedule = await this.schedule(trigger, now);
      add('trigger', JSON.stringify(trigger));
      sets[sets.length - 1] = `trigger = $${params.length}::jsonb`;
      add('status', schedule.status);
      add('next_run_at', schedule.nextRunAt);
      add('attempts', 0);
      add('last_error', null);
      add('last_error_code', null);
    }
    add('updated_at', now);
    await this.dataSource.transaction(async (m) => {
      await m.query(`UPDATE task_queue SET ${sets.join(', ')} WHERE id = $1`, params);
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'queue.updated',
          target: id,
          ip: actor.ip,
          details: { fields: Object.keys(body), ...(body.prompt !== undefined ? { prompt_length: body.prompt.length, confirmation } : {}), ...(body.trigger ? { trigger_type: body.trigger.type } : {}) },
        },
        m,
      );
    });
    this.bus.publish({ type: 'queue.changed', queueId: id });
    return this.getDto(id);
  }

  async cancel(id: string, actor: QueueActor, now: Date = new Date()): Promise<QueueItemDto> {
    const changed = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: QueueStatus }> = await m.query(`SELECT status FROM task_queue WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Queue item not found' });
      if (!['queued', 'waiting_trigger'].includes(rows[0].status)) return false;
      await m.query(`UPDATE task_queue SET status = 'cancelled', next_run_at = NULL, updated_at = $2 WHERE id = $1`, [id, now]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'queue.cancelled', target: id, ip: actor.ip, details: {} }, m);
      return true;
    });
    if (changed) this.bus.publish({ type: 'queue.changed', queueId: id });
    return this.getDto(id);
  }

  /** Yakuniy (started|failed|cancelled) elementni o'chiradi; faol elementni avval bekor qiling. */
  async remove(id: string, actor: QueueActor): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: QueueStatus }> = await m.query(`SELECT status FROM task_queue WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Queue item not found' });
      if (['queued', 'waiting_trigger', 'starting'].includes(rows[0].status)) throw new ConflictException({ error: 'queue_active', message: 'Cancel the item before deleting it' });
      await m.query(`DELETE FROM task_queue WHERE id = $1`, [id]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'queue.deleted', target: id, ip: actor.ip, details: {} }, m);
    });
  }

  /** "Hozir ishga tushir": triggerni kutmaydi, lekin lockdown/offline/policy tekshiruvlari saqlanadi (scheduler). */
  async markRunNow(id: string, actor: QueueActor, now: Date = new Date()): Promise<QueueItemDto> {
    const ok = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: QueueStatus }> = await m.query(`SELECT status FROM task_queue WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Queue item not found' });
      if (!['queued', 'waiting_trigger'].includes(rows[0].status)) return false;
      await m.query(`UPDATE task_queue SET next_run_at = $2, attempts = 0, updated_at = $2 WHERE id = $1`, [id, now]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'queue.run_now', target: id, ip: actor.ip, details: {} }, m);
      return true;
    });
    if (!ok) throw new ConflictException({ error: 'queue_not_runnable', message: 'Item is not waiting' });
    this.bus.publish({ type: 'queue.changed', queueId: id });
    return this.getDto(id);
  }

  // --- o'qish ------------------------------------------------------------------------------------

  async getRow(id: string): Promise<QueueRow> {
    const rows: QueueRow[] = await this.dataSource.query(`${SELECT_DTO} WHERE q.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Queue item not found' });
    return rows[0];
  }

  async getDto(id: string): Promise<QueueItemDto> {
    return toQueueDto(await this.getRow(id));
  }

  async list(q: ListQueueQuery): Promise<ListQueueResponse> {
    const rows: QueueRow[] = await this.dataSource.query(
      `${SELECT_DTO}
        WHERE ($1::text IS NULL OR q.status = $1) AND ($2::uuid IS NULL OR q.machine_id = $2) AND ($3::uuid IS NULL OR q.project_id = $3)
          AND ($4::text IS NULL OR q.trigger->>'type' = $4)
        ORDER BY (q.status IN ${ACTIVE}) DESC, COALESCE(q.next_run_at, q.created_at) ASC, q.id ASC
        LIMIT $5`,
      [q.status ?? null, q.machine ?? null, q.project ?? null, q.triggerType ?? null, q.limit],
    );
    return { items: rows.map(toQueueDto) };
  }

  async detail(id: string): Promise<QueueDetailResponse> {
    const item = await this.getDto(id);
    const runs: Array<{ id: string; fired_at: Date; status: QueueRunDto['status']; command_id: string | null; session_id: string | null; error_code: string | null }> =
      await this.dataSource.query(
        `SELECT id, fired_at, status, command_id, session_id, error_code FROM task_queue_runs WHERE queue_id = $1 ORDER BY fired_at DESC LIMIT 50`,
        [id],
      );
    return { item, runs: runs.map((r) => ({ id: r.id, firedAt: r.fired_at.toISOString(), status: r.status, commandId: r.command_id, sessionId: r.session_id, errorCode: r.error_code })) };
  }

  // --- ichki -------------------------------------------------------------------------------------

  private async requireConfirmation(mode: CreateQueueItemBody['permissionMode'], actor: QueueActor): Promise<QueueConfirmation> {
    if (actor.actorKind === 'system' && actor.orchestrationConfirmation && mode !== 'auto') return actor.orchestrationConfirmation;
    const confirmation = confirmationFor({
      mode,
      exemptDevice: await this.isStepUpExempt(actor.deviceId),
      actorKind: actor.actorKind,
      inline: actor.confirmation === 'telegram_inline',
    });
    if (!confirmation) {
      throw new HttpException(
        { error: 'step_up_required', message: 'Queueing a session requires the same confirmation as starting one: use the exempt dashboard device or confirm in Telegram' },
        422,
      );
    }
    return confirmation;
  }

  private async normalizeTrigger(t: QueueTrigger, now: Date): Promise<QueueTrigger> {
    try {
      scheduleFor(t, now, null); // faqat tekshiruv
    } catch (err) {
      if (err instanceof TriggerError) throw new BadRequestException({ error: err.code, message: err.message });
      throw err;
    }
    return t;
  }

  private async schedule(trigger: QueueTrigger, now: Date): Promise<{ status: QueueStatus; nextRunAt: Date | null }> {
    let reset: Date | null = null;
    if (trigger.type === 'limit_reset') reset = await this.limitResetAt(trigger.window, now);
    return scheduleFor(trigger, now, reset);
  }

  /** Tanlangan oynaning keyingi reset vaqti + slack (noma'lum bo'lsa null: scheduler keyin bog'laydi). */
  async limitResetAt(window: '5h' | '7d', now: Date): Promise<Date | null> {
    const limits = await this.limits.current(now);
    const view = window === '5h' ? limits.fiveHour : limits.sevenDay;
    if (!view?.resetsAt) return null;
    const t = Date.parse(view.resetsAt);
    if (!Number.isFinite(t) || t <= now.getTime()) return view.reset ? null : new Date(now.getTime() + LIMIT_RESET_SLACK_MS);
    return new Date(t + LIMIT_RESET_SLACK_MS);
  }

  /** Scheduler uchun: tranzaksiya ichida (qator qulflangan). */
  async lockDue(m: EntityManager, id: string, now: Date): Promise<(QueueRow & { prompt_enc: Buffer; fire_seq: number; creation_audit_id: string | null }) | null> {
    const rows: Array<QueueRow & { prompt_enc: Buffer; fire_seq: number; creation_audit_id: string | null }> = await m.query(
      `${SELECT_DTO.replace('SELECT q.id,', 'SELECT q.prompt_enc, q.fire_seq, q.creation_audit_id::text AS creation_audit_id, q.id,')}
        WHERE q.id = $1 AND q.status IN ('queued', 'waiting_trigger') AND q.next_run_at IS NOT NULL AND q.next_run_at <= $2
        FOR UPDATE OF q SKIP LOCKED`,
      [id, now],
    );
    return rows[0] ?? null;
  }

  nextCron(expr: string, after: Date): Date | null {
    return nextCronRun(expr, after);
  }
}
