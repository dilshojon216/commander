import { HttpException, Inject, Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GIT_OPS_LIMITS } from '@commander/contracts';
import type {
  CiRefreshBody,
  CommandDto,
  CreateCommandResponse,
  DiffResponse,
  OpenPrBody,
  ProjectCiDto,
  ProjectDiffBody,
  ProjectGitResponse,
  ProjectPrDto,
  TaskCommitDto,
} from '@commander/contracts';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { ciPollKey, gitHttpStatus, resolveSessionBase } from './git-logic.js';
import { GIT_OPS_OPTIONS } from './git-ops.options.js';
import type { GitOpsOptions } from './git-ops.options.js';

/** Buyruq darhol rad/fail bo'lsa HTTP xatosiga aylantiradi (diff REST'i sinxron). */
function throwIfFailed(c: CommandDto): void {
  if (c.status === 'rejected' || c.status === 'failed' || c.status === 'expired') {
    throw new HttpException({ error: c.errorCode ?? c.status, message: c.errorMessage ?? `Command ${c.status}`, commandId: c.id }, gitHttpStatus(c.errorCode));
  }
}

interface PrRow {
  id: string;
  project_id: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  opened_via: string;
  created_at: Date;
}

interface CiRow {
  branch: string;
  state: ProjectCiDto['state'];
  pr_number: number | null;
  pr_url: string | null;
  checks: ProjectCiDto['checks'];
  run: ProjectCiDto['run'];
  checked_at: Date;
}

/** Git/PR (3.5): diff (loyiha va sessiya), PR ochish, CI holati (davriy + talab bo'yicha), vazifaga bog'langan commitlar. */
@Injectable()
export class GitOpsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(GitOpsService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
    @Inject(GIT_OPS_OPTIONS) private readonly options: GitOpsOptions,
  ) {}

  onModuleInit(): void {
    if (this.options.ciPollMs <= 0) return;
    this.timer = setInterval(() => void this.pollCi().catch((err: unknown) => this.logger.error(`CI poll failed: ${err instanceof Error ? err.message : String(err)}`)), this.options.ciPollMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async assertProject(projectId: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
  }

  // --- diff ------------------------------------------------------------------------------------

  private async runDiff(projectId: string, sessionId: string | null, baseSource: DiffResponse['baseSource'], body: { base?: string | undefined; statOnly?: boolean | undefined }, actor: CommandActor): Promise<DiffResponse> {
    const created = await this.commands.create(
      { type: 'project.diff', projectId, ...(body.base ? { base: body.base } : {}), ...(body.statOnly ? { statOnly: true } : {}) },
      actor,
      undefined,
    );
    throwIfFailed(created.command);
    const { command, timedOut } = await this.commands.waitFinished(created.command.id, GIT_OPS_LIMITS.diffWaitMs);
    if (timedOut) throw new HttpException({ error: 'agent_timeout', message: 'The agent did not return the diff in time', commandId: command.id }, 504);
    throwIfFailed(command);
    const diff = this.commands.takeDiff(command.id);
    if (!diff) throw new HttpException({ error: 'invalid_result', message: 'The diff is no longer available; retry', commandId: command.id }, 502);
    return { projectId, sessionId, commandId: command.id, baseSource, diff };
  }

  async diffForProject(projectId: string, body: ProjectDiffBody, actor: CommandActor): Promise<DiffResponse> {
    await this.assertProject(projectId);
    return this.runDiff(projectId, null, body.base ? 'explicit' : 'head', body, actor);
  }

  /** Sessiya diff'i: sessiya boshidagi HEAD'dan hozirgi ishchi daraxtgacha (commitlar + commit qilinmagan o'zgarishlar). */
  async diffForSession(sessionId: string, body: ProjectDiffBody, actor: CommandActor): Promise<DiffResponse> {
    const rows: Array<{ project_id: string | null; start_head_sha: string | null; started_at: Date }> = await this.dataSource.query(
      `SELECT project_id, start_head_sha, started_at FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const s = rows[0];
    if (!s) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    if (!s.project_id) throw new ConflictException({ error: 'no_project', message: 'The session is not linked to a project' });
    if (body.base) return this.runDiff(s.project_id, sessionId, 'explicit', body, actor);
    const snap: Array<{ head_sha: string | null }> = s.start_head_sha
      ? []
      : await this.dataSource.query(
          `SELECT head_sha FROM project_snapshots WHERE project_id = $1 AND taken_at <= $2 AND head_sha IS NOT NULL ORDER BY taken_at DESC LIMIT 1`,
          [s.project_id, s.started_at],
        );
    const b = resolveSessionBase({ startHeadSha: s.start_head_sha, snapshotHeadSha: snap[0]?.head_sha ?? null });
    return this.runDiff(s.project_id, sessionId, b.source, { base: b.base, statOnly: body.statOnly }, actor);
  }

  // --- PR / CI ---------------------------------------------------------------------------------

  /** `project.open_pr` (step-up qoidalari bo'yicha). 201 + buyruq; natija (PR URL/raqam) `command.updated` bilan keladi. */
  async openPr(projectId: string, body: OpenPrBody, actor: CommandActor, idempotencyKey: string | undefined): Promise<CreateCommandResponse> {
    await this.assertProject(projectId);
    return this.commands.create({ type: 'project.open_pr', projectId, title: body.title, body: body.body, base: body.base, draft: body.draft, ...(body.head ? { head: body.head } : {}) }, actor, idempotencyKey);
  }

  /** CI holatini hozir so'rash (`gh`, faqat o'qish). Natija `project_ci_status` ga yoziladi va `project.updated` push qilinadi. */
  async refreshCi(projectId: string, body: CiRefreshBody, actor: CommandActor, idempotencyKey?: string): Promise<CreateCommandResponse> {
    await this.assertProject(projectId);
    return this.commands.create({ type: 'project.ci_status', projectId, ...(body.branch ? { branch: body.branch } : {}) }, actor, idempotencyKey);
  }

  /**
   * Davriy (5 daqiqa): ochiq PR'li har (loyiha, branch) uchun `project.ci_status`. Aktor = PR'ni ochgan qurilma (`system` turida),
   * shu sabab buyruq oddiy konveyer orqali (audit, siyosat, imzo). Mashina offline bo'lsa buyruq `rejected` bo'ladi (navbatga qo'yilmaydi).
   */
  async pollCi(now: Date = new Date()): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const rows: Array<{ project_id: string; branch: string; device_id: string }> = await this.dataSource.query(
        `SELECT DISTINCT ON (p.project_id, p.branch) p.project_id, p.branch, p.opened_by_device_id AS device_id
           FROM project_prs p JOIN projects pr ON pr.id = p.project_id JOIN machines m ON m.id = pr.machine_id
          WHERE p.state = 'open' AND p.opened_by_device_id IS NOT NULL AND m.online
            AND NOT EXISTS (SELECT 1 FROM commands c WHERE c.project_id = p.project_id AND c.type = 'project.ci_status'
                              AND c.status IN ('pending','sent','acked','running') AND c.payload->>'branch' = p.branch)
          ORDER BY p.project_id, p.branch, p.created_at DESC`,
      );
      let n = 0;
      for (const r of rows) {
        const actor: CommandActor = { deviceId: r.device_id, actorKind: 'system', ip: null };
        try {
          await this.commands.create({ type: 'project.ci_status', projectId: r.project_id, branch: r.branch }, actor, ciPollKey(r.project_id, r.branch, now.getTime(), this.options.ciPollMs || GIT_OPS_LIMITS.ciPollMs), now);
          n += 1;
        } catch (err) {
          this.logger.warn(`CI poll command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return n;
    } finally {
      this.polling = false;
    }
  }

  // --- o'qish ----------------------------------------------------------------------------------

  async getGit(projectId: string): Promise<ProjectGitResponse> {
    await this.assertProject(projectId);
    const [ciRows, prRows, tcRows] = await Promise.all([
      this.dataSource.query(`SELECT branch, state, pr_number, pr_url, checks, run, checked_at FROM project_ci_status WHERE project_id = $1 ORDER BY checked_at DESC LIMIT 20`, [projectId]) as Promise<CiRow[]>,
      this.dataSource.query(
        `SELECT id, project_id, number, url, title, branch, base, draft, state, opened_via, created_at FROM project_prs WHERE project_id = $1
          ORDER BY (state = 'open') DESC, created_at DESC LIMIT 30`,
        [projectId],
      ) as Promise<PrRow[]>,
      this.dataSource.query(
        `SELECT sha, task_key, source, subject, author, committed_at FROM (
           SELECT tc.*, row_number() OVER (PARTITION BY task_key ORDER BY committed_at DESC) AS rn FROM task_commits tc WHERE project_id = $1
         ) t WHERE rn <= $2 ORDER BY committed_at DESC LIMIT 500`,
        [projectId, GIT_OPS_LIMITS.maxCommitsPerTask],
      ) as Promise<Array<{ sha: string; task_key: string; source: 'subject' | 'branch'; subject: string; author: string; committed_at: Date }>>,
    ]);
    const ci: ProjectCiDto[] = ciRows.map((r) => ({ branch: r.branch, state: r.state, prNumber: r.pr_number, prUrl: r.pr_url, checks: r.checks ?? [], run: r.run ?? null, checkedAt: r.checked_at.toISOString() }));
    const prs: ProjectPrDto[] = prRows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      number: r.number,
      url: r.url,
      title: r.title,
      branch: r.branch,
      base: r.base,
      draft: r.draft,
      state: r.state,
      openedVia: r.opened_via,
      createdAt: r.created_at.toISOString(),
    }));
    const taskCommits: TaskCommitDto[] = tcRows.map((r) => ({ sha: r.sha, taskKey: r.task_key, source: r.source, subject: r.subject, author: r.author, ts: r.committed_at.toISOString() }));
    return { projectId, ci, prs, taskCommits };
  }

  async projectName(projectId: string): Promise<string> {
    const rows: Array<{ name: string }> = await this.dataSource.query(`SELECT name FROM projects WHERE id = $1`, [projectId]);
    return rows[0]?.name ?? projectId;
  }

  /** Telegram uchun: sessiya + loyiha ma'lumoti (PR default'lari). */
  async prContextForSession(sessionId: string): Promise<{ startedBy: string; projectId: string; projectName: string; branch: string | null; sessionName: string | null; taskKey: string | null; taskTitle: string | null; commitSubjects: string[] } | null> {
    const rows: Array<{ project_id: string | null; name: string | null; session_name: string | null; claude_session_id: string; machine_id: string; started_by: string }> = await this.dataSource.query(
      `SELECT s.project_id, p.name, s.name AS session_name, s.started_by, s.claude_session_id, s.machine_id FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = $1`,
      [sessionId],
    );
    const s = rows[0];
    if (!s?.project_id) return null;
    const snap: Array<{ branch: string | null; commits: Array<{ subject: string }> | null }> = await this.dataSource.query(
      `SELECT branch, commits FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`,
      [s.project_id],
    );
    const span: Array<{ task_key: string; title: string | null }> = await this.dataSource.query(
      `SELECT sp.task_key, pt.title FROM session_task_spans sp LEFT JOIN project_tasks pt ON pt.project_id = sp.project_id AND pt.task_key = sp.task_key
        WHERE sp.machine_id = $1 AND sp.session_id = $2 ORDER BY sp.started_at DESC LIMIT 1`,
      [s.machine_id, s.claude_session_id],
    );
    return {
      startedBy: s.started_by,
      projectId: s.project_id,
      projectName: s.name ?? s.project_id,
      branch: snap[0]?.branch ?? null,
      sessionName: s.session_name,
      taskKey: span[0]?.task_key ?? null,
      taskTitle: span[0]?.title ?? null,
      commitSubjects: (snap[0]?.commits ?? []).slice(0, 10).map((c) => c.subject),
    };
  }
}
