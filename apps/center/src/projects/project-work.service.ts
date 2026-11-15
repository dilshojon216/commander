import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PROJECT_OPS_LIMITS, extractCandidateTasks, suggestTaskKeys } from '@commander/contracts';
import type {
  AppendTasksBody,
  CommandDto,
  CreateCommandResponse,
  MdExtractBody,
  MdExtractResponse,
  MdFilesResponse,
  ParsedTask,
  PatchBoardResponse,
  TaskBoardColumn,
} from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { DailyService } from './daily.service.js';
import { effectiveColumn } from './task-board.js';

interface SnapshotMeta {
  md_files: string[] | null;
  tasks_path: 'docs/TASKS.md' | 'TASKS.md' | null;
  tasks_hash: string | null;
  taken_at: Date;
}

/** Komanda xato kodi -> HTTP holati (REST'da sinxron kutiladigan buyruqlar uchun). */
export function httpStatusForCommandError(code: string | null): number {
  switch (code) {
    case 'machine_offline':
      return 409;
    case 'lockdown':
    case 'policy_disabled':
    case 'action_not_allowed':
    case 'cwd_not_allowed':
    case 'center_key_unpinned':
    case 'running_as_root':
      return 403;
    case 'tasks_md_changed':
      return 409;
    case 'agent_timeout':
    case 'dispatch_expired':
      return 504;
    default:
      return 502;
  }
}

/** Doska surish, md fayllar, md->vazifa, TASKS.md'ga qo'shish, yangilash, kun xulosasi (2.15). */
@Injectable()
export class ProjectWorkService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    private readonly commands: CommandsService,
    private readonly daily: DailyService,
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
  }

  private async latestSnapshot(projectId: string): Promise<SnapshotMeta | null> {
    const rows: SnapshotMeta[] = await this.dataSource.query(
      `SELECT md_files, tasks_path, tasks_hash, taken_at FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ?? null;
  }

  private async projectTasks(projectId: string): Promise<Array<Pick<ParsedTask, 'key' | 'title' | 'phase'>>> {
    const rows: Array<{ task_key: string; title: string; phase: string | null }> = await this.dataSource.query(
      `SELECT task_key, title, phase FROM project_tasks WHERE project_id = $1 AND part = '' ORDER BY "order"`,
      [projectId],
    );
    return rows.map((r) => ({ key: r.task_key, title: r.title, phase: r.phase }));
  }

  // --- doska -----------------------------------------------------------------------------------

  /**
   * `PATCH .../tasks/:taskKey/board`: overlay + `task_events` + audit bitta tranzaksiyada. TASKS.md `done` vazifa surilmaydi
   * (`changed=false`, haqiqiy ustun `done`). `project.updated` push (bus `project.changed`).
   */
  async setBoard(projectId: string, taskKey: string, column: TaskBoardColumn, actor: CommandActor): Promise<PatchBoardResponse> {
    const res = await this.dataSource.transaction(async (m): Promise<PatchBoardResponse> => {
      const rows: Array<{ status: 'todo' | 'doing' | 'done' | 'unknown'; part: string }> = await m.query(`SELECT status, part FROM project_tasks WHERE project_id = $1 AND task_key = $2`, [projectId, taskKey]);
      if (!rows[0]) {
        const p: unknown[] = await m.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
        if (p.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
        throw new NotFoundException({ error: 'task_not_found', message: 'The task is not in the project\'s TASKS.md' });
      }
      const mdStatus = rows[0].status;
      const ov: Array<{ board_column: TaskBoardColumn }> = await m.query(`SELECT board_column FROM task_board WHERE project_id = $1 AND task_key = $2 FOR UPDATE`, [projectId, taskKey]);
      const active: unknown[] = await m.query(`SELECT 1 FROM session_task_spans WHERE project_id = $1 AND task_key = $2 AND ended_at IS NULL LIMIT 1`, [projectId, taskKey]);
      const before = effectiveColumn({ mdStatus, overlay: ov[0]?.board_column ?? null, hasActiveSpan: active.length > 0 });
      if (before.source === 'tasks_md') {
        await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'task.board.refused', target: projectId, ip: actor.ip, details: { task_key: taskKey, requested: column, reason: 'tasks_md_done' } }, m);
        return { projectId, taskKey, column: 'done', columnSource: 'tasks_md', changed: false };
      }
      await m.query(
        `INSERT INTO task_board (project_id, task_key, board_column, updated_by_device_id, updated_at, part) VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (project_id, task_key) DO UPDATE SET board_column = EXCLUDED.board_column, updated_by_device_id = EXCLUDED.updated_by_device_id, updated_at = now()`,
        [projectId, taskKey, column, actor.deviceId, rows[0].part],
      );
      const changed = before.column !== column;
      if (changed) {
        await m.query(`INSERT INTO task_events (project_id, task_key, from_status, to_status, source, device_id) VALUES ($1, $2, $3, $4, 'board', $5)`, [projectId, taskKey, before.column, column, actor.deviceId]);
      }
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'task.board.set', target: projectId, ip: actor.ip, details: { task_key: taskKey, from: before.column, to: column } },
        m,
      );
      return { projectId, taskKey, column, columnSource: 'board', changed };
    });
    this.bus.publish({ type: 'project.changed', projectId });
    return res;
  }

  // --- md fayllar va vazifalar -----------------------------------------------------------------

  async mdFiles(projectId: string): Promise<MdFilesResponse> {
    await this.assertProject(projectId);
    const snap = await this.latestSnapshot(projectId);
    return { projectId, files: snap?.md_files ?? [], takenAt: snap ? snap.taken_at.toISOString() : null };
  }

  /** Buyruq yaratildi, lekin darhol rad/fail bo'lsa HTTP xatosiga aylantiradi. */
  private throwIfFailed(c: CommandDto): void {
    if (c.status === 'rejected' || c.status === 'failed' || c.status === 'expired') {
      throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, httpStatusForCommandError(c.errorCode));
    }
  }

  async mdExtract(projectId: string, body: MdExtractBody, actor: CommandActor): Promise<MdExtractResponse> {
    await this.assertProject(projectId);
    const snap = await this.latestSnapshot(projectId);
    if (!snap?.md_files) throw new ConflictException({ error: 'md_files_unknown', message: 'The agent has not reported the project\'s md files yet (refresh the project)' });
    if (!snap.md_files.includes(body.path)) throw new NotFoundException({ error: 'md_not_listed', message: 'The file is not in the project\'s md list' });

    const created = await this.commands.create({ type: 'project.read_md', projectId, path: body.path }, actor, undefined);
    this.throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, PROJECT_OPS_LIMITS.mdExtractWaitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not return the file in time', commandId: command.id }, 504);
    this.throwIfFailed(command);
    const md = this.commands.takeMd(command.id);
    if (!md) throw new HttpException({ error: 'invalid_result', message: 'The file content is no longer available; retry', commandId: command.id }, 502);

    const tasks = await this.projectTasks(projectId);
    const phases = [...new Set(tasks.map((t) => t.phase).filter((p): p is string => p !== null))];
    const suggestedPhase = body.phase ?? phases[phases.length - 1] ?? null;
    const cands = extractCandidateTasks(md.content, tasks);
    const fresh = cands.filter((c) => c.alreadyInTasks === null);
    const keys = suggestTaskKeys(tasks, suggestedPhase, fresh.length);
    let ki = 0;
    return {
      projectId,
      path: md.path,
      bytes: md.bytes,
      truncated: md.truncated,
      phases,
      suggestedPhase,
      candidates: cands.map((c) => ({ ...c, suggestedKey: c.alreadyInTasks === null ? (keys[ki++] ?? '') : c.alreadyInTasks })),
      commandId: command.id,
    };
  }

  /** `POST .../tasks/append`: imzolangan `project.append_tasks` (step-up qoidalari bo'yicha). Natija `command.updated` bilan keladi. */
  async append(projectId: string, body: AppendTasksBody, actor: CommandActor, idempotencyKey: string | undefined): Promise<CreateCommandResponse> {
    await this.assertProject(projectId);
    const snap = await this.latestSnapshot(projectId);
    if (!snap?.tasks_path || !snap.tasks_hash) {
      throw new ConflictException({ error: 'tasks_md_unknown', message: 'No TASKS.md snapshot with a content hash yet (refresh the project or update agentd)' });
    }
    const existing = await this.projectTasks(projectId);
    const taken = new Set(existing.map((t) => t.key));
    const dup = body.tasks.filter((t) => taken.has(t.key)).map((t) => t.key);
    if (dup.length > 0) throw new ConflictException({ error: 'task_key_exists', message: 'Some task ids already exist in TASKS.md', keys: dup });
    return this.commands.create(
      { type: 'project.append_tasks', projectId, tasksPath: snap.tasks_path, baseHash: snap.tasks_hash, phase: body.phase, tasks: body.tasks },
      actor,
      idempotencyKey,
    );
  }

  /** "TASKS.md'dan yangilash": agentd darhol yangi snapshot yuboradi (faqat o'qish, step-up yo'q). */
  async refresh(projectId: string, actor: CommandActor): Promise<CreateCommandResponse> {
    return this.commands.create({ type: 'project.refresh', projectId }, actor, undefined);
  }

  /** `POST .../daily/:date/summary`: faqat tuzilgan statistika bilan `project.summarize` (haiku). Natija `daily_summaries`ga yoziladi (`part` bo'lsa shu qism kaliti bilan alohida, 6.18). */
  async summarize(projectId: string, day: string, actor: CommandActor, now: Date = new Date(), part?: string): Promise<CreateCommandResponse> {
    await this.assertProject(projectId);
    if (this.daily.isFuture(day, now)) throw new BadRequestException({ error: 'invalid_request', message: 'The day is in the future' });
    const input = await this.daily.summarizeInput(projectId, day, now, part);
    if (!input) throw new ConflictException({ error: 'no_activity', message: 'There is nothing to summarize for this day' });
    return this.commands.create({ type: 'project.summarize', projectId, input, ...(part ? { part } : {}) }, actor, undefined);
  }
}

