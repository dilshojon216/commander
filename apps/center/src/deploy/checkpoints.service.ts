import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CHECKPOINT_LIMITS,
  CheckpointListResultSchema,
  CheckpointResultSchema,
  CheckpointRestoreResultSchema,
  CheckpointAutoSettingsSchema,
  DEFAULT_CHECKPOINT_AUTO,
} from '@commander/contracts';
import type { CheckpointAutoSettings, CheckpointListResult, CheckpointResult, CommandDto, CreateCommandResponse } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { beforeStartHooks } from '../commands/before-start.js';
import { isFailedStatus, repoHttpStatus } from './deploy-logic.js';

const SETTING_KEY = 'checkpoints.auto';

const throwIfFailed = (c: CommandDto): void => {
  if (isFailedStatus(c.status)) throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, repoHttpStatus(c.errorCode));
};

/**
 * Git checkpoint'lar (6.9) markaz tomoni. Hamma amal imzolangan buyruq (audit + lokal siyosat). Yaratish va ro'yxat sinxron (<= 45 s);
 * qaytarish (`git.checkpoint_restore`) step-up talab qiladi: 201 + buyruq, natija `command.updated` bilan keladi.
 * Avto-checkpoint: `settings['checkpoints.auto']` (`bigTask`, `orchestration`; default o'chiq); xato asosiy amalni to'xtatmaydi.
 */
@Injectable()
export class CheckpointsService implements OnModuleInit, OnModuleDestroy {
  private unregister: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit(): void {
    this.unregister = beforeStartHooks.set(async (i, actor) => void (await this.autoBefore(i.kind, i.machineId, i.cwd, i.label, actor)));
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  private async assertProject(projectId: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
  }

  async create(projectId: string, label: string, actor: CommandActor, auto = false): Promise<{ commandId: string; result: CheckpointResult }> {
    await this.assertProject(projectId);
    const created = await this.commands.create({ type: 'git.checkpoint', projectId, label, ...(auto ? { auto: true } : {}) }, actor, undefined);
    throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, CHECKPOINT_LIMITS.waitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not finish the checkpoint in time', commandId: command.id }, 504);
    throwIfFailed(command);
    const parsed = CheckpointResultSchema.safeParse(this.commands.takeRepoResult(command.id));
    if (!parsed.success) throw new HttpException({ error: 'invalid_result', message: 'The checkpoint result is no longer available; list checkpoints', commandId: command.id }, 502);
    return { commandId: command.id, result: parsed.data };
  }

  async list(projectId: string, actor: CommandActor): Promise<{ commandId: string; result: CheckpointListResult }> {
    await this.assertProject(projectId);
    const created = await this.commands.create({ type: 'git.checkpoint_list', projectId }, actor, undefined);
    throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, CHECKPOINT_LIMITS.waitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not list checkpoints in time', commandId: command.id }, 504);
    throwIfFailed(command);
    const parsed = CheckpointListResultSchema.safeParse(this.commands.takeRepoResult(command.id));
    if (!parsed.success) throw new HttpException({ error: 'invalid_result', message: 'The list is no longer available; retry', commandId: command.id }, 502);
    return { commandId: command.id, result: parsed.data };
  }

  /** Qaytarish: step-up (Telegram yoki inline). Natija (`CheckpointRestoreResult`) `command.updated` da emas, `restoreResult` orqali o'qiladi. */
  restore(projectId: string, ref: string, actor: CommandActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    return this.assertProject(projectId).then(() => this.commands.create({ type: 'git.checkpoint_restore', projectId, ref }, actor, idempotencyKey));
  }

  /** `git.checkpoint_restore` natijasi (bir marta olinadi; markaz xotirasi). */
  restoreResult(commandId: string): unknown {
    return CheckpointRestoreResultSchema.safeParse(this.commands.takeRepoResult(commandId)).data;
  }

  // --- avto-checkpoint sozlamalari ----------------------------------------------------------------

  async autoSettings(): Promise<CheckpointAutoSettings> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [SETTING_KEY]);
    const parsed = CheckpointAutoSettingsSchema.safeParse(rows[0]?.value);
    return parsed.success ? parsed.data : DEFAULT_CHECKPOINT_AUTO;
  }

  async setAutoSettings(v: CheckpointAutoSettings): Promise<CheckpointAutoSettings> {
    await this.dataSource.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTING_KEY, JSON.stringify(v)],
    );
    return v;
  }

  /**
   * Avto-checkpoint (best-effort): shu mashinadagi `cwd` ni qamrab oluvchi loyiha(lar) uchun. Sozlama o'chiq, loyiha yo'q yoki agent rad
   * etsa JIM o'tadi (asosiy amal to'xtamaydi); sabab `null`/matn bilan qaytadi (auditda `command.created` bor).
   */
  async autoBefore(kind: 'bigTask' | 'orchestration', machineId: string, cwd: string, label: string, actor: CommandActor): Promise<{ done: boolean; reason: string }> {
    try {
      const s = await this.autoSettings();
      if (!s[kind]) return { done: false, reason: 'disabled' };
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT id FROM projects WHERE machine_id = $1 AND ($2 = path OR $2 LIKE path || '/%') ORDER BY length(path) DESC LIMIT 1`,
        [machineId, cwd],
      );
      const projectId = rows[0]?.id;
      if (!projectId) return { done: false, reason: 'no_project' };
      const safe = label.replace(/[^A-Za-z0-9 ._-]+/g, ' ').trim().slice(0, 50) || 'task';
      await this.create(projectId, `auto ${safe}`.slice(0, CHECKPOINT_LIMITS.labelMaxChars), actor, true);
      return { done: true, reason: 'ok' };
    } catch (err) {
      return { done: false, reason: err instanceof HttpException ? String((err.getResponse() as { error?: string }).error ?? 'error') : 'error' };
    }
  }
}
