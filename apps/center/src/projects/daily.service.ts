import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DAILY_MAX_DAYS, PART_PATH_RE, PROJECT_OPS_LIMITS, buildPlan, estimateHours, partSlug } from '@commander/contracts';
import type { DailyDay, DailyDoneTask, DailyResponse, DailySummaryDto, DailyTask, SummarizeInput, TokenTotals } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { ProjectWorkDataService } from './project-work-data.service.js';
import { RAW_USAGE_RETENTION_DAYS, TaskStatsService, statsKey } from './task-stats.service.js';
import { daysBetween, isValidDay, tashkentDayOf, tashkentDayRange } from './tashkent-day.js';

const ZERO: TokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    requests: a.requests + b.requests,
  };
}

interface DoneEventRow {
  task_key: string;
  source: 'tasks_md' | 'board';
  ts: Date;
}

/** Kunlik ko'rinish (2.15): Asia/Tashkent kunlari bo'yicha vazifalar, yopilganlar, jami va saqlangan xulosa. */
@Injectable()
export class DailyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stats: TaskStatsService,
    private readonly work: ProjectWorkDataService,
  ) {}

  /** `from`/`to` (`YYYY-MM-DD`, ikkalasi ham kiradi). Berilmasa bugun. */
  resolveRange(from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
    const today = tashkentDayOf(now);
    const f = from ?? to ?? today;
    const t = to ?? from ?? today;
    if (!isValidDay(f) || !isValidDay(t)) throw new BadRequestException({ error: 'invalid_request', message: 'from/to must be valid YYYY-MM-DD dates' });
    if (f > t) throw new BadRequestException({ error: 'invalid_request', message: 'from must not be after to' });
    if (daysBetween(f, t).length > DAILY_MAX_DAYS) throw new BadRequestException({ error: 'invalid_request', message: `range is limited to ${DAILY_MAX_DAYS} days` });
    return { from: f, to: t };
  }

  /** Vazifa kaliti qism filtriga mosmi (`part` undefined = filtrsiz; '' = ildiz; aks holda `<slug>:` prefiksi). */
  static inPart(taskKey: string, part: string | undefined): boolean {
    if (part === undefined) return true;
    return part === '' ? !taskKey.includes(':') : taskKey.startsWith(`${partSlug(part)}:`);
  }

  async daily(projectId: string, fromIn: string | undefined, toIn: string | undefined, part?: string, now: Date = new Date()): Promise<DailyResponse> {
    if (part !== undefined && part !== '' && !PART_PATH_RE.test(part)) throw new BadRequestException({ error: 'invalid_request', message: 'part must be a project part path' });
    const exists: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (exists.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    const { from, to } = this.resolveRange(fromIn, toIn, now);
    const days = daysBetween(from, to);
    const rangeStart = tashkentDayRange(from).start;
    const rangeEnd = tashkentDayRange(to).end;

    const [taskRows, sizeMap, scores, summaryRows, eventRows] = await Promise.all([
      this.dataSource.query(`SELECT task_key, title, size FROM project_tasks WHERE project_id = $1`, [projectId]) as Promise<Array<{ task_key: string; title: string; size: string | null }>>,
      this.work.sizeHours(),
      this.work.latestScores(projectId),
      this.dataSource.query(
        // 6.18: xulosa qism kaliti bilan saqlanadi; filtr yo'q yoki '' = butun loyiha xulosasi (avvalgidek)
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, summary, scores, model, created_at FROM daily_summaries WHERE project_id = $1 AND day BETWEEN $2::date AND $3::date AND part = $4`,
        [projectId, from, to, part ?? ''],
      ) as Promise<Array<{ day: string; summary: string; scores: DailySummaryDto['scores']; model: string; created_at: Date }>>,
      this.dataSource.query(
        `SELECT task_key, source, ts FROM task_events WHERE project_id = $1 AND to_status = 'done' AND ts >= $2 AND ts < $3 ORDER BY ts`,
        [projectId, rangeStart, rangeEnd],
      ) as Promise<DoneEventRow[]>,
    ]);
    const info = new Map(taskRows.map((r) => [r.task_key, r]));
    const summaries = new Map(summaryRows.map((r) => [r.day, { day: r.day, summary: r.summary, scores: Array.isArray(r.scores) ? r.scores : [], model: r.model, createdAt: r.created_at.toISOString() } satisfies DailySummaryDto]));
    const doneByDay = new Map<string, Map<string, DoneEventRow>>();
    for (const e of eventRows) {
      const d = tashkentDayOf(e.ts);
      const m = doneByDay.get(d) ?? new Map<string, DoneEventRow>();
      m.set(e.task_key, e); // kun ichidagi eng so'nggisi
      doneByDay.set(d, m);
    }

    const out: DailyDay[] = [];
    const CHUNK = 6;
    for (let i = 0; i < days.length; i += CHUNK) {
      const chunk = await Promise.all(days.slice(i, i + CHUNK).map((day) => this.oneDay(projectId, day, now, info, sizeMap, scores, summaries.get(day) ?? null, doneByDay.get(day) ?? null, part)));
      out.push(...chunk);
    }
    return { projectId, timezone: 'Asia/Tashkent', days: out, tokensCoveredFrom: new Date(now.getTime() - RAW_USAGE_RETENTION_DAYS * 86_400_000).toISOString() };
  }

  private async oneDay(
    projectId: string,
    day: string,
    now: Date,
    info: Map<string, { task_key: string; title: string; size: string | null }>,
    sizeMap: Record<string, number>,
    scores: Awaited<ReturnType<ProjectWorkDataService['latestScores']>>,
    summary: DailySummaryDto | null,
    done: Map<string, DoneEventRow> | null,
    part: string | undefined,
  ): Promise<DailyDay> {
    const { start, end } = tashkentDayRange(day);
    if (start.getTime() > now.getTime()) {
      return { date: day, tasks: [], doneTasks: [], totals: emptyTotals(), summary };
    }
    // Bugun: hozirgacha (kelajakdagi oyna "working" oralig'ini cho'zib yubormasin)
    const winEnd = end.getTime() > now.getTime() ? now : end;
    const scope = { projectIds: [projectId], from: start, to: winEnd };
    const [byTask, unattributed, sessions] = await Promise.all([this.stats.byTask(scope, now), this.stats.unattributed(scope, part ?? null), this.stats.sessionCount(scope, part ?? null)]);

    const tasks: DailyTask[] = [];
    let tokens = ZERO;
    let active = 0;
    for (const [k, st] of byTask) {
      const taskKey = k.slice(projectId.length + 1);
      if (!DailyService.inPart(taskKey, part)) continue;
      const row = info.get(taskKey);
      const first = new Date(Math.max(new Date(st.firstActivityAt ?? start).getTime(), start.getTime()));
      const last = new Date(Math.min(new Date(st.lastActivityAt ?? winEnd).getTime(), winEnd.getTime()));
      tasks.push({
        taskKey,
        title: row?.title ?? null,
        firstActivityAt: first.toISOString(),
        lastActivityAt: (last.getTime() < first.getTime() ? first : last).toISOString(),
        activeSeconds: st.activeSeconds,
        tokens: st.tokens,
        sessions: st.sessions,
        plan: buildPlan(estimateHours(row?.size ?? null, sizeMap), st.activeSeconds),
        score: scores.get(taskKey) ?? null,
      });
      tokens = addTotals(tokens, st.tokens);
      active += st.activeSeconds;
    }
    tasks.sort((a, b) => a.firstActivityAt.localeCompare(b.firstActivityAt) || a.taskKey.localeCompare(b.taskKey));

    const doneTasks: DailyDoneTask[] = [...(done?.values() ?? [])].filter((e) => DailyService.inPart(e.task_key, part)).map((e) => ({ taskKey: e.task_key, title: info.get(e.task_key)?.title ?? null, source: e.source, ts: e.ts.toISOString() }));
    const sc = summary?.scores ?? [];
    return {
      date: day,
      tasks,
      doneTasks,
      totals: {
        tasksWorked: tasks.length,
        tasksDone: doneTasks.length,
        activeSeconds: active,
        sessions,
        totalTokens: tokens.totalTokens,
        costUsd: tokens.costUsd,
        unattributedTokens: unattributed.tokens.totalTokens,
        avgScore: sc.length > 0 ? Math.round((sc.reduce((a, s) => a + s.score, 0) / sc.length) * 10) / 10 : null,
      },
      summary,
    };
  }

  /**
   * Claude'ga beriladigan FAQAT tuzilgan statistika (kod/transcript yo'q): vazifa id/sarlavhasi (redakt), vaqt, token,
   * commit sarlavhalari (redakt). Bo'sh bo'lsa `null` (xulosa qilinadigan narsa yo'q).
   */
  async summarizeInput(projectId: string, day: string, now: Date = new Date(), part?: string): Promise<SummarizeInput | null> {
    // 6.18: `part` berilsa (bo'sh emas) faqat shu qism vazifalari; '' / yo'q = butun loyiha (avvalgidek)
    const scope = part ? part : undefined;
    const res = await this.daily(projectId, day, day, scope, now);
    const d = res.days[0]!;
    // Commit sarlavhalari qismga bog'lanmagan (snapshot butun loyiha): qism xulosasiga kirmaydi
    const commitRows: Array<{ commits: Array<{ subject: string; ts: number }> }> = await this.dataSource.query(
      `SELECT commits FROM project_snapshots WHERE project_id = $1 ORDER BY taken_at DESC, id DESC LIMIT 1`,
      [projectId],
    );
    const commits = (scope ? [] : (commitRows[0]?.commits ?? [])).filter((c) => tashkentDayOf(new Date(c.ts)) === day).slice(0, PROJECT_OPS_LIMITS.maxSummarizeCommits);
    const doneKeys = new Set(d.doneTasks.map((t) => t.taskKey));
    const tasks = d.tasks.map((t) => ({
      key: t.taskKey,
      title: redactAndCap(t.title ?? t.taskKey, PROJECT_OPS_LIMITS.summarizeTitleMaxChars) || t.taskKey,
      activeSeconds: t.activeSeconds,
      totalTokens: Math.round(t.tokens.totalTokens),
      sessions: t.sessions,
      estimateHours: t.plan.estimateHours,
      doneThatDay: doneKeys.has(t.taskKey),
    }));
    for (const dt of d.doneTasks) {
      if (tasks.some((t) => t.key === dt.taskKey)) continue;
      tasks.push({ key: dt.taskKey, title: redactAndCap(dt.title ?? dt.taskKey, PROJECT_OPS_LIMITS.summarizeTitleMaxChars) || dt.taskKey, activeSeconds: 0, totalTokens: 0, sessions: 0, estimateHours: null, doneThatDay: true });
    }
    if (tasks.length === 0 && commits.length === 0) return null;
    return {
      day,
      tasks: tasks.slice(0, PROJECT_OPS_LIMITS.maxSummarizeTasks),
      commitSubjects: commits.map((c) => redactAndCap(c.subject, PROJECT_OPS_LIMITS.summarizeTitleMaxChars)).filter((s) => s.length > 0),
    };
  }

  /** Kun kelajakdami (bugundan keyin)? */
  isFuture(day: string, now: Date): boolean {
    return day > tashkentDayOf(now);
  }
}

function emptyTotals(): DailyDay['totals'] {
  return { tasksWorked: 0, tasksDone: 0, activeSeconds: 0, sessions: 0, totalTokens: 0, costUsd: null, unattributedTokens: 0, avgScore: null };
}
