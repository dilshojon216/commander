import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEPLOY_LIMITS } from '@commander/contracts';
import type { CommandDto, CreateCommandResponse, DeployInspectResponse, DeployInspectResult, DeployRunBody, DeployRunDto, DeployRunsResponse, LogsReadResponse } from '@commander/contracts';
import { DeployInspectResultSchema } from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { LogsRelayService } from '../logs/logs-relay.service.js';
import { inspectNotes, isFailedStatus, planFor, repoHttpStatus, toRunDto } from './deploy-logic.js';

const throwIfFailed = (c: CommandDto): void => {
  if (isFailedStatus(c.status)) throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, repoHttpStatus(c.errorCode));
};

/**
 * Bir bosishda deploy (6.5) markaz tomoni. Markaz retsept matnini mijozdan QABUL QILMAYDI: `deploy.inspect` (agent pin qilingan commit'dan
 * o'qiydi) natijasi egasiga ko'rsatiladi; ijro (`deploy.run|rollback`) FAQAT (target, commit, recipeHash) uchlik bilan, markaz uni
 * qayta `inspect` qilib xeshni solishtiradi (tasdiq kartasidagi reja = xeshga mos reja), step-up HAR DOIM, bir maqsadga bitta deploy.
 */
@Injectable()
export class DeployService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
    private readonly relay: LogsRelayService,
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
  }

  /** `deploy.inspect`: sinxron (<= 45 s). Retsept/xesh/commit/siyosat holati qaytadi; hech narsa saqlanmaydi. */
  async inspect(projectId: string, commit: string | undefined, actor: CommandActor): Promise<DeployInspectResponse> {
    await this.assertProject(projectId);
    const created = await this.commands.create({ type: 'deploy.inspect', projectId, ...(commit ? { commit } : {}) }, actor, undefined);
    throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, DEPLOY_LIMITS.inspectWaitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not inspect the recipe in time', commandId: command.id }, 504);
    throwIfFailed(command);
    const raw = this.commands.takeRepoResult(command.id);
    const parsed = DeployInspectResultSchema.safeParse(raw);
    if (!parsed.success) throw new HttpException({ error: 'invalid_result', message: 'The inspection is no longer available; retry', commandId: command.id }, 502);
    return { commandId: command.id, status: command.status, errorCode: null, errorMessage: null, inspect: parsed.data };
  }

  private async exec(type: 'deploy.run' | 'deploy.rollback', projectId: string, body: DeployRunBody, actor: CommandActor, idempotencyKey: string | undefined): Promise<CreateCommandResponse> {
    // Tasdiq kartasi/xesh mosligi: markaz retseptni o'zi qayta o'qitadi (mijoz bergan xesh ishonchsiz)
    const fresh = await this.inspect(projectId, undefined, actor); // HEAD: ijro faqat HEAD tasdiqlangan commit bo'lsa
    const i: DeployInspectResult = fresh.inspect as DeployInspectResult;
    if (!i.valid || !i.recipe || !i.recipeHash) throw new HttpException({ error: 'recipe_invalid', message: `The recipe is invalid: ${i.issues[0] ?? 'unknown'}` }, 422);
    if (i.recipeHash !== body.recipeHash) throw new ConflictException({ error: 'recipe_changed', message: 'The recipe changed since you reviewed it; reload and review again' });
    if (i.commit !== body.commit && !i.commit.startsWith(body.commit)) throw new ConflictException({ error: 'commit_changed', message: `HEAD is now at ${i.commit.slice(0, 8)}, not the commit you reviewed (${body.commit.slice(0, 8)}); reload and review again` });
    if (i.dirty) throw new ConflictException({ error: 'dirty_worktree', message: 'There are uncommitted changes to tracked files; commit or stash them first' });
    const target = i.recipe.targets.find((t) => t.name === body.target);
    if (!target) throw new NotFoundException({ error: 'target_not_found', message: `Target "${body.target}" is not in the recipe` });
    if (i.machineMatches[target.name] !== true) throw new ConflictException({ error: 'machine_mismatch', message: `This target is for machine "${target.machine}", not this project's machine` });
    if (type === 'deploy.rollback' && target.rollback.length === 0) throw new HttpException({ error: 'recipe_invalid', message: 'The target defines no rollback steps' }, 422);
    const plan = planFor(target, type === 'deploy.run' ? 'run' : 'rollback', i.commit, i.recipeHash);
    const notes = [`commit ${i.commit.slice(0, 8)}${i.branch ? ` (${i.branch})` : ''} · recipe ${i.recipeHash.slice(0, 8)} · maqsad ${target.name}`, ...inspectNotes(i, target)];
    const out = await this.commands.create(
      { type, projectId, target: target.name, recipeHash: i.recipeHash, commit: i.commit, plan },
      { ...actor, reviewNotes: [...(actor.reviewNotes ?? []), ...notes] },
      idempotencyKey,
    );
    // deploy chiqishi: relay buferi (o'quvchisiz ham to'xtatilmaydi); hech qayerda saqlanmaydi
    if (!isFailedStatus(out.command.status)) this.relay.register(out.command.id, out.command.machineId, Date.now(), true);
    return out;
  }

  run(projectId: string, body: DeployRunBody, actor: CommandActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    return this.exec('deploy.run', projectId, body, actor, idempotencyKey);
  }

  rollback(projectId: string, body: DeployRunBody, actor: CommandActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    return this.exec('deploy.rollback', projectId, body, actor, idempotencyKey);
  }

  /** Tarix: loyihaning eng yangi deploy/rollback buyruqlari (chiqish saqlanmaydi: faqat xulosa). */
  async runs(projectId: string): Promise<DeployRunsResponse> {
    await this.assertProject(projectId);
    const rows: Array<Parameters<typeof toRunDto>[0]> = await this.dataSource.query(
      `SELECT id, type, status, payload, result, error_code, error_message, requested_by_device_id, created_at, finished_at
         FROM commands WHERE project_id = $1 AND type IN ('deploy.run', 'deploy.rollback') ORDER BY created_at DESC, id DESC LIMIT $2`,
      [projectId, DEPLOY_LIMITS.historyMax],
    );
    const items: DeployRunDto[] = rows.map((r) => toRunDto(r));
    return { items };
  }

  /** Jonli chiqish (cursor): `GET /v1/deploy/runs/:id/output?after=`. */
  async output(commandId: string, after: number): Promise<LogsReadResponse> {
    const dto = await this.commands.getDto(commandId);
    if (dto.type !== 'deploy.run' && dto.type !== 'deploy.rollback') throw new NotFoundException({ error: 'not_found', message: 'Deploy run not found' });
    const r = this.relay.read(commandId, after);
    const failed = isFailedStatus(dto.status);
    const cmdError = { code: dto.errorCode ?? 'failed', message: dto.errorMessage ?? 'The command failed' };
    if (r) {
      if (failed && r.state !== 'done' && r.state !== 'error' && dto.errorCode !== 'deploy_failed') return { ...r, state: 'error', reason: 'error', error: cmdError };
      return r;
    }
    const base = { commandId, lines: [] as string[], nextSeq: after, dropped: 0, truncated: false };
    if (failed) return { ...base, state: 'error', reason: 'error', error: cmdError };
    if (dto.status === 'done') return { ...base, state: 'done', reason: 'ended', error: null };
    return { ...base, state: 'starting', reason: null, error: null };
  }

  /** Telegram rollback tugmasi uchun: tugagan deploy buyrug'ining (loyiha, maqsad, commit, xesh, rollback bormi). */
  async rollbackContext(commandId: string): Promise<{ projectId: string; projectName: string; run: DeployRunDto } | null> {
    const rows: Array<Parameters<typeof toRunDto>[0] & { project_id: string | null; project_name: string | null }> = await this.dataSource.query(
      `SELECT c.id, c.type, c.status, c.payload, c.result, c.error_code, c.error_message, c.requested_by_device_id, c.created_at, c.finished_at,
              c.project_id, p.name AS project_name
         FROM commands c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND c.type IN ('deploy.run', 'deploy.rollback')`,
      [commandId],
    );
    const r = rows[0];
    if (!r || !r.project_id) return null;
    return { projectId: r.project_id, projectName: r.project_name ?? r.project_id, run: toRunDto(r) };
  }
}
