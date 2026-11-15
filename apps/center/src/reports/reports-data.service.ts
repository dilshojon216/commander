import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_SIZE_HOURS, SizeHoursSettingSchema, TASK_SIZE_HOURS_SETTING, estimateHours } from '@commander/contracts';
import type { ReportData } from '@commander/contracts';
import { weightedTokens } from '../limits/limits-logic.js';
import { LimitsService } from '../limits/limits.service.js';
import { tashkentDayRange } from '../projects/tashkent-day.js';
import { TaskStatsService, statsKey } from '../projects/task-stats.service.js';
import { buildReport } from './report-logic.js';
import type { ModelRow, Period, TaskModelRow, TaskStatRow } from './report-logic.js';

const ACTIVE_CAP_HOURS = 4;
const NUMS = `COALESCE(sum(tu.input_tokens),0)::float8 AS input, COALESCE(sum(tu.output_tokens),0)::float8 AS output,
  COALESCE(sum(tu.cache_read_tokens),0)::float8 AS cache_read, COALESCE(sum(tu.cache_creation_tokens),0)::float8 AS cache_creation,
  sum(tu.cost_usd)::float8 AS cost, count(*)::float8 AS requests`;

interface NumRow {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost: number | null;
  requests: number;
}

/** Hisobot uchun SQL yig'ish (3.3). Davr = Toshkent kunlari `[from 00:00, to+1 00:00)`. */
@Injectable()
export class ReportsDataService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stats: TaskStatsService,
    private readonly limits: LimitsService,
  ) {}

  async build(period: Period, now: Date = new Date()): Promise<ReportData> {
    const start = tashkentDayRange(period.from).start;
    const end = tashkentDayRange(period.to).end;
    // Davr tugamagan bo'lsa (masalan /report bugun) kelajak oyna uzunligini cho'zmasin.
    const winEnd = end.getTime() > now.getTime() ? now : end;
    const q = <T>(sql: string, params: unknown[]): Promise<T[]> => this.dataSource.query(sql, params) as Promise<T[]>;

    const [projects, modelRows, closed, commits, active, sessions, taskModelRows, byTask, taskInfo, summaries, sizeMap, limits] = await Promise.all([
      q<{ id: string; name: string }>(`SELECT id, name FROM projects`, []),
      q<NumRow & { project_id: string | null; model: string }>(
        `SELECT tu.project_id, tu.model, ${NUMS} FROM token_usage tu WHERE tu.ts >= $1 AND tu.ts < $2 GROUP BY 1, 2`,
        [start, winEnd],
      ),
      q<{ project_id: string; task_key: string; title: string | null }>(
        `SELECT DISTINCT ON (e.project_id, e.task_key) e.project_id, e.task_key, t.title
           FROM task_events e LEFT JOIN project_tasks t ON t.project_id = e.project_id AND t.task_key = e.task_key
          WHERE e.to_status = 'done' AND e.ts >= $1 AND e.ts < $2
          ORDER BY e.project_id, e.task_key, e.ts DESC`,
        [start, winEnd],
      ),
      q<{ project_id: string; n: number }>(
        `SELECT ps.project_id, count(DISTINCT c->>'sha')::int AS n
           FROM project_snapshots ps CROSS JOIN LATERAL jsonb_array_elements(ps.commits) c
          WHERE (c->>'ts')::bigint >= $1 AND (c->>'ts')::bigint < $2 GROUP BY 1`,
        [start.getTime(), winEnd.getTime()],
      ),
      q<{ project_id: string | null; seconds: number }>(
        `WITH ev AS (
           SELECT e.session_id, e.ts, e.status, lead(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS next_ts
             FROM session_events e WHERE e.ts >= $1::timestamptz - interval '${ACTIVE_CAP_HOURS} hours' AND e.ts < $2
         )
         SELECT s.project_id, sum(GREATEST(0, EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(ev.next_ts, ev.ts + interval '${ACTIVE_CAP_HOURS} hours'), ev.ts + interval '${ACTIVE_CAP_HOURS} hours', $2::timestamptz) - GREATEST(ev.ts, $1::timestamptz)))))::float8 AS seconds
           FROM ev JOIN sessions s ON s.id = ev.session_id WHERE ev.status = 'working' GROUP BY 1`,
        [start, winEnd],
      ),
      q<{ project_id: string | null; n: number }>(
        `SELECT tu.project_id, count(DISTINCT (tu.machine_id, tu.session_id))::int AS n FROM token_usage tu WHERE tu.ts >= $1 AND tu.ts < $2 AND tu.session_id IS NOT NULL GROUP BY 1`,
        [start, winEnd],
      ),
      q<NumRow & { project_id: string; task_key: string; model: string }>(
        `SELECT sp.project_id, sp.task_key, tu.model, ${NUMS}
           FROM session_task_spans sp
           JOIN token_usage tu ON tu.machine_id = sp.machine_id AND tu.session_id = sp.session_id
            AND tu.ts >= GREATEST(sp.started_at, $1::timestamptz) AND tu.ts < LEAST(COALESCE(sp.ended_at, 'infinity'::timestamptz), $2::timestamptz)
          WHERE sp.project_id IS NOT NULL AND sp.started_at < $2 AND COALESCE(sp.ended_at, 'infinity'::timestamptz) > $1
          GROUP BY 1, 2, 3`,
        [start, winEnd],
      ),
      this.stats.byTask({ projectIds: null, from: start, to: winEnd }, now),
      q<{ project_id: string; task_key: string; title: string; size: string | null }>(`SELECT project_id, task_key, title, size FROM project_tasks`, []),
      q<{ project_id: string; day: string; summary: string }>(`SELECT project_id, to_char(day, 'YYYY-MM-DD') AS day, summary FROM daily_summaries WHERE part = '' AND day BETWEEN $1::date AND $2::date`, [period.from, period.to]),
      this.sizeMap(),
      this.limitsBlock(now),
    ]);

    const models: ModelRow[] = modelRows.map((r) => ({ projectId: r.project_id, model: r.model, input: r.input, output: r.output, cacheRead: r.cache_read, cacheCreation: r.cache_creation, cost: r.cost, requests: r.requests }));
    const info = new Map(taskInfo.map((t) => [statsKey(t.project_id, t.task_key), t] as const));
    const taskModels: TaskModelRow[] = taskModelRows.map((r) => ({
      projectId: r.project_id,
      key: r.task_key,
      model: r.model,
      weighted: weightedTokens({ input: r.input, output: r.output, cacheRead: r.cache_read, cacheCreation: r.cache_creation }),
      output: r.output,
      requests: r.requests,
    }));
    const taskAgg = new Map<string, TaskStatRow>();
    for (const m of taskModelRows) {
      const k = statsKey(m.project_id, m.task_key);
      const row = info.get(k);
      const cur = taskAgg.get(k) ?? { projectId: m.project_id, key: m.task_key, title: row?.title ?? null, plannedHours: estimateHours(row?.size ?? null, sizeMap)?.hours ?? null, weighted: 0, cost: null, activeSeconds: byTask.get(k)?.activeSeconds ?? 0 };
      cur.weighted += weightedTokens({ input: m.input, output: m.output, cacheRead: m.cache_read, cacheCreation: m.cache_creation });
      cur.cost = m.cost === null ? cur.cost : (cur.cost ?? 0) + m.cost;
      taskAgg.set(k, cur);
    }
    // Faqat faol vaqti bor (token yo'q) vazifalar ham reja-haqiqiy hisobiga kirsin.
    for (const [k, st] of byTask) {
      if (taskAgg.has(k) || st.activeSeconds <= 0) continue;
      const [projectId, ...rest] = k.split('|');
      const key = rest.join('|');
      const row = info.get(k);
      taskAgg.set(k, { projectId: projectId!, key, title: row?.title ?? null, plannedHours: estimateHours(row?.size ?? null, sizeMap)?.hours ?? null, weighted: 0, cost: null, activeSeconds: st.activeSeconds });
    }

    return buildReport({
      period,
      projects,
      models,
      closed: closed.map((c) => ({ projectId: c.project_id, key: c.task_key, title: c.title })),
      commits: commits.map((c) => ({ projectId: c.project_id, count: c.n })),
      active: active.map((a) => ({ projectId: a.project_id, seconds: a.seconds })),
      sessions: sessions.map((s) => ({ projectId: s.project_id, sessions: s.n })),
      tasks: [...taskAgg.values()],
      taskModels,
      summaries: summaries.map((s) => ({ projectId: s.project_id, day: s.day, summary: s.summary })),
      limits,
    });
  }

  private async sizeMap(): Promise<Record<string, number>> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [TASK_SIZE_HOURS_SETTING]);
    const parsed = SizeHoursSettingSchema.safeParse(rows[0]?.value);
    return parsed.success ? { ...DEFAULT_SIZE_HOURS, ...parsed.data } : { ...DEFAULT_SIZE_HOURS };
  }

  private async limitsBlock(now: Date): Promise<ReportData['limits']> {
    try {
      const l = await this.limits.current(now);
      const five = l.fiveHour;
      const seven = l.sevenDay;
      if (!five && !seven) return null;
      const source = (five ?? seven)!.source;
      return { fiveHourPct: five ? five.usedPct : null, sevenDayPct: seven ? seven.usedPct : null, source: five && seven && five.source !== seven.source ? 'estimate' : source };
    } catch {
      return null;
    }
  }
}
