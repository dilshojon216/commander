import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildPlan, estimateHours, summarizeTasks } from '@commander/contracts';
import type {
  ListProjectCommitsResponse,
  ListTasksQuery,
  ListTasksResponse,
  ProjectCommitDto,
  ProjectDetailDto,
  ProjectTaskDto,
  ProjectTasksResponse,
  ProjectUpdatedPayload,
  TaskStats,
  TasksMdMeta,
  TasksSummary,
} from '@commander/contracts';
import { UsageService } from '../api/usage.service.js';
import { ProjectWorkDataService } from './project-work-data.service.js';
import { effectiveColumn } from './task-board.js';
import { RAW_USAGE_RETENTION_DAYS, TaskStatsService, statsKey } from './task-stats.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SnapshotRow {
  taken_at: Date;
  branch: string | null;
  head_sha: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_count: number | null;
  commits: Array<{ sha: string; subject: string; author: string; ts: number }>;
  todos_md: string | null;
  changelog_md: string | null;
  tasks_bytes: number | null;
  tasks_path: string | null;
}

const EMPTY_STATS: TaskStats = {
  tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 },
  sessions: 0,
  activeSeconds: 0,
  firstActivityAt: null,
  lastActivityAt: null,
  source: null,
};

const toCommits = (rows: SnapshotRow['commits'], limit: number): ProjectCommitDto[] =>
  (Array.isArray(rows) ? rows : []).slice(0, limit).map((c) => ({ sha: c.sha, subject: c.subject, author: c.author, ts: new Date(c.ts).toISOString() }));

/** Loyiha detali, commitlar, vazifalar (2.2) va vazifa statistikasi (2.9) uchun o'qish API'si. */
@Injectable()
export class ProjectsReadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly stats: TaskStatsService,
    private readonly work: ProjectWorkDataService,
  ) {}

  private async latestSnapshot(projectId: string): Promise<SnapshotRow | null> {
    const rows: SnapshotRow[] = await this.dataSource.query(
      `SELECT taken_at, branch, head_sha, ahead, behind, dirty_count, commits, todos_md, changelog_md,
              octet_length(tasks_md) AS tasks_bytes, tasks_path
         FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ?? null;
  }

  private async tasksSummary(projectId: string): Promise<TasksSummary> {
    const rows: Array<{ status: 'todo' | 'doing' | 'done' | 'unknown' }> = await this.dataSource.query(`SELECT status FROM project_tasks WHERE project_id = $1 AND part = ''`, [projectId]);
    return summarizeTasks(rows);
  }

  private tasksMeta(snap: SnapshotRow | null, summary: TasksSummary): TasksMdMeta | null {
    if (!snap?.tasks_path) return null;
    return { path: snap.tasks_path, bytes: snap.tasks_bytes ?? 0, summary, updatedAt: snap.taken_at.toISOString() };
  }

  async detail(projectId: string): Promise<ProjectDetailDto> {
    const project = await this.usage.projectById(projectId);
    if (!project) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    const [snap, summary] = await Promise.all([this.latestSnapshot(projectId), this.tasksSummary(projectId)]);
    return {
      project,
      git: snap
        ? {
            branch: snap.branch,
            headSha: snap.head_sha,
            dirty: snap.dirty_count === null ? null : snap.dirty_count > 0,
            dirtyCount: snap.dirty_count,
            ahead: snap.ahead,
            behind: snap.behind,
            takenAt: snap.taken_at.toISOString(),
          }
        : null,
      commits: snap ? toCommits(snap.commits, 30) : [],
      todosMd: snap?.todos_md ?? null,
      changelogMd: snap?.changelog_md ?? null,
      tasksMd: this.tasksMeta(snap, summary),
    };
  }

  async commits(projectId: string, limit: number): Promise<ListProjectCommitsResponse> {
    await this.assertProject(projectId);
    const snap = await this.latestSnapshot(projectId);
    return { items: snap ? toCommits(snap.commits, limit) : [], takenAt: snap ? snap.taken_at.toISOString() : null };
  }

  async tasks(projectId: string, now: Date = new Date()): Promise<ProjectTasksResponse> {
    await this.assertProject(projectId);
    const scope = { projectIds: [projectId], from: null, to: null };
    const [rows, stats, unattributed, snap, overlays, activeKeys, sizeMap, scores] = await Promise.all([
      this.dataSource.query(
        `SELECT task_key, part, title, phase, status, raw_status, "order", size FROM project_tasks WHERE project_id = $1 ORDER BY part, "order"`,
        [projectId],
      ) as Promise<Array<{ task_key: string; part: string; title: string; phase: string | null; status: ProjectTaskDto['status']; raw_status: string | null; order: number; size: string | null }>>,
      this.stats.byTask(scope, now),
      this.stats.unattributed(scope),
      this.latestSnapshot(projectId),
      this.work.overlays(projectId),
      this.work.activeSpanKeys(projectId),
      this.work.sizeHours(),
      this.work.latestScores(projectId),
    ]);
    const known = new Set(rows.map((r) => r.task_key));
    const tasks: ProjectTaskDto[] = rows.map((r) => {
      const st = stats.get(statsKey(projectId, r.task_key)) ?? EMPTY_STATS;
      const col = effectiveColumn({ mdStatus: r.status, overlay: overlays.get(r.task_key) ?? null, hasActiveSpan: activeKeys.has(r.task_key) });
      return {
        key: r.task_key,
        part: r.part,
        title: r.title,
        phase: r.phase,
        status: r.status,
        rawStatus: r.raw_status,
        order: r.order,
        size: r.size,
        stats: st,
        column: col.column,
        columnSource: col.source,
        plan: buildPlan(estimateHours(r.size, sizeMap), st.activeSeconds),
        score: scores.get(r.task_key) ?? null,
      };
    });
    const other = [...stats.entries()]
      .filter(([k]) => !known.has(k.slice(projectId.length + 1)))
      .map(([k, v]) => ({ key: k.slice(projectId.length + 1), stats: v }))
      .sort((a, b) => b.stats.tokens.totalTokens - a.stats.tokens.totalTokens);
    // `summary` = ILDIZ reja fayli (TASKS.md) bo'yicha (eski ma'no); qismlar bo'yicha: `GET /v1/projects/:id/parts`
    const summary = summarizeTasks(rows.filter((r) => r.part === ''));
    return {
      projectId,
      tasks,
      other,
      unattributed,
      summary,
      tasksMd: this.tasksMeta(snap, summary),
      tokensCoveredFrom: new Date(now.getTime() - RAW_USAGE_RETENTION_DAYS * 86_400_000).toISOString(),
    };
  }

  /** `GET /v1/tasks`: vazifa kesimidagi statistika (loyiha/repo/mashina filtri bilan). */
  async taskSummary(q: ListTasksQuery, now: Date = new Date()): Promise<ListTasksResponse> {
    const ids = await this.resolveProjectIds(q);
    const scope = { projectIds: ids, from: q.from ? new Date(q.from) : null, to: q.to ? new Date(q.to) : null };
    if (ids !== null && ids.length === 0) {
      return { items: [], unattributed: await this.stats.unattributed({ ...scope, projectIds: [] }), tokensCoveredFrom: this.coveredFrom(now) };
    }
    const [stats, unattributed] = await Promise.all([this.stats.byTask(scope, now), this.stats.unattributed(scope)]);
    const projectIds = [...new Set([...stats.keys()].map((k) => k.slice(0, 36)))];
    const [names, titles] = projectIds.length
      ? await Promise.all([
          this.dataSource.query(`SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]) as Promise<Array<{ id: string; name: string }>>,
          this.dataSource.query(`SELECT project_id, task_key, title, status FROM project_tasks WHERE project_id = ANY($1::uuid[])`, [projectIds]) as Promise<
            Array<{ project_id: string; task_key: string; title: string; status: ProjectTaskDto['status'] }>
          >,
        ])
      : [[], []];
    const nameBy = new Map(names.map((n) => [n.id, n.name]));
    const titleBy = new Map(titles.map((t) => [statsKey(t.project_id, t.task_key), t]));
    const items = [...stats.entries()]
      .map(([k, s]) => {
        const projectId = k.slice(0, 36);
        const taskKey = k.slice(37);
        const t = titleBy.get(k);
        return { projectId, projectName: nameBy.get(projectId) ?? projectId, taskKey, title: t?.title ?? null, status: t?.status ?? null, stats: s };
      })
      .sort((a, b) => b.stats.tokens.totalTokens - a.stats.tokens.totalTokens || a.taskKey.localeCompare(b.taskKey))
      .slice(0, q.limit);
    return { items, unattributed, tokensCoveredFrom: this.coveredFrom(now) };
  }

  /** `/ws/client` uchun yengil push yuklamasi (md yo'q). */
  async updatedPayload(projectId: string): Promise<ProjectUpdatedPayload | null> {
    const rows: Array<{ id: string; machine_id: string; name: string; path: string; repo_key: string | null }> = await this.dataSource.query(
      `SELECT id, machine_id, name, path, repo_key FROM projects WHERE id = $1`,
      [projectId],
    );
    const p = rows[0];
    if (!p) return null;
    const [snap, summary] = await Promise.all([this.latestSnapshot(projectId), this.tasksSummary(projectId)]);
    if (!snap) return null;
    return {
      project: {
        id: p.id,
        machineId: p.machine_id,
        name: p.name,
        path: p.path,
        repoKey: p.repo_key,
        branch: snap.branch,
        headSha: snap.head_sha,
        dirty: snap.dirty_count === null ? null : snap.dirty_count > 0,
        takenAt: snap.taken_at.toISOString(),
        tasks: summary.total > 0 ? summary : null,
      },
    };
  }

  private coveredFrom(now: Date): string {
    return new Date(now.getTime() - RAW_USAGE_RETENTION_DAYS * 86_400_000).toISOString();
  }

  private async assertProject(id: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
  }

  /** `null` = filtrsiz (hamma loyiha). */
  private async resolveProjectIds(q: ListTasksQuery): Promise<string[] | null> {
    if (!q.project && !q.repo && !q.machine) return null;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    if (q.project) {
      if (UUID_RE.test(q.project)) where.push(`p.id = ${add(q.project)}::uuid`);
      else where.push(`lower(p.name) = lower(${add(q.project)})`);
    }
    if (q.repo) where.push(`p.repo_key = ${add(q.repo.toLowerCase())}`);
    if (q.machine) {
      const m = add(q.machine);
      where.push(`(m.id::text = ${m} OR m.slug = ${m})`);
    }
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT p.id FROM projects p JOIN machines m ON m.id = p.machine_id WHERE ${where.join(' AND ')}`, params);
    return rows.map((r) => r.id);
  }
}
