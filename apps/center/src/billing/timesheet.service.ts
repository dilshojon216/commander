import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BILLING_LIMITS, DEFAULT_SIZE_HOURS, SizeHoursSettingSchema, TASK_SIZE_HOURS_SETTING, estimateHours } from '@commander/contracts';
import type { BillingCurrency, TimesheetDto, TimesheetQuery } from '@commander/contracts';
import { isValidDay, tashkentDayRange } from '../projects/tashkent-day.js';
import { UNKNOWN_PROJECT_KEY, buildTimesheet, monthRange, periodDays, taskId } from './timesheet-logic.js';
import type { ClientRow, EventRow, SpanRow, TaskInfo, TokenSums } from './timesheet-logic.js';

const KEY_SQL = (alias: string): string => `COALESCE(${alias}.repo_key, ${alias}.id::text)`;
type Row = Record<string, unknown>;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const tokens = (r: Row): TokenSums => ({ input: num(r['input']), output: num(r['output']), cacheRead: num(r['cache_read']), cacheCreation: num(r['cache_creation']) });
const SUMS = `COALESCE(sum(%I.input_tokens),0)::float8 AS input, COALESCE(sum(%I.output_tokens),0)::float8 AS output,
  COALESCE(sum(%I.cache_read_tokens),0)::float8 AS cache_read, COALESCE(sum(%I.cache_creation_tokens),0)::float8 AS cache_creation, sum(%I.cost_usd)::float8 AS cost`;
const sums = (a: string): string => SUMS.replaceAll('%I', a);

/** Davr so'rovidan `from/to` (Toshkent kunlari): `month` yoki `from+to`; tekshiruvlar bilan. */
export function resolvePeriod(q: Pick<TimesheetQuery, 'from' | 'to' | 'month'>): { from: string; to: string } {
  const p = q.month ? monthRange(q.month) : { from: q.from!, to: q.to! };
  if (!isValidDay(p.from) || !isValidDay(p.to)) throw new BadRequestException({ error: 'invalid_period', message: "Sana noto'g'ri" });
  if (p.to < p.from) throw new BadRequestException({ error: 'invalid_period', message: "Tugash sanasi boshlanishdan oldin" });
  if (periodDays(p.from, p.to) > BILLING_LIMITS.maxPeriodDays) throw new BadRequestException({ error: 'period_too_long', message: `Davr ${BILLING_LIMITS.maxPeriodDays} kundan oshmasin` });
  return p;
}

/** Timesheet SQL yig'ish (6.7). Davr = Toshkent kunlari `[from 00:00, to+1 00:00)`. Mantiq: `timesheet-logic.ts`. */
@Injectable()
export class TimesheetService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async build(q: TimesheetQuery, now: Date = new Date()): Promise<TimesheetDto> {
    const { from, to } = resolvePeriod(q);
    const start = tashkentDayRange(from).start;
    const end = tashkentDayRange(to).end;
    const currency: BillingCurrency | null = q.currency ?? null;
    const query = <T extends Row>(sql: string, params: unknown[]): Promise<T[]> => this.dataSource.query(sql, params) as Promise<T[]>;

    const [projects, clientRows, mappingRows, eventRows, spanRows, projTok, taskTok, closed, projCommits, taskCommits, infoRows, sizeMap] = await Promise.all([
      query(`SELECT p.id, p.name, ${KEY_SQL('p')} AS project_key FROM projects p ORDER BY p.created_at DESC`, []),
      query(`SELECT id, name, hourly_rate::text AS hourly_rate, currency FROM clients`, []),
      query(`SELECT project_key, client_id FROM client_projects`, []),
      query(
        `WITH ev AS (
           SELECT e.session_id, e.ts, e.status, lead(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS next_ts
             FROM session_events e WHERE e.ts >= $1::timestamptz - interval '4 hours' AND e.ts < $2::timestamptz
         )
         SELECT ev.session_id, s.project_id, (SELECT ${KEY_SQL('p')} FROM projects p WHERE p.id = s.project_id) AS project_key,
                ev.ts, ev.status, ev.next_ts
           FROM ev JOIN sessions s ON s.id = ev.session_id
          WHERE ev.status IN ('working', 'awaiting_approval')`,
        [start, end],
      ),
      query(
        `SELECT s.id AS session_id, ${KEY_SQL('p')} AS project_key, sp.task_key, sp.started_at, sp.ended_at
           FROM session_task_spans sp
           JOIN sessions s ON s.machine_id = sp.machine_id AND s.claude_session_id = sp.session_id
           JOIN projects p ON p.id = sp.project_id
          WHERE sp.started_at < $2::timestamptz AND COALESCE(sp.ended_at, 'infinity'::timestamptz) > $1::timestamptz`,
        [start, end],
      ),
      query(
        `SELECT ${KEY_SQL('p')} AS project_key, ${sums('d')}
           FROM token_usage_daily_by_project d LEFT JOIN projects p ON p.id = d.project_id
          WHERE d.day >= $1::timestamptz AND d.day < $2::timestamptz GROUP BY 1`,
        [start, end],
      ),
      query(
        `SELECT ${KEY_SQL('p')} AS project_key, sp.task_key, ${sums('tu')}, count(DISTINCT (sp.machine_id, sp.session_id))::int AS sessions
           FROM session_task_spans sp
           JOIN projects p ON p.id = sp.project_id
           JOIN token_usage tu ON tu.machine_id = sp.machine_id AND tu.session_id = sp.session_id
            AND tu.ts >= GREATEST(sp.started_at, $1::timestamptz) AND tu.ts < LEAST(COALESCE(sp.ended_at, 'infinity'::timestamptz), $2::timestamptz)
          WHERE sp.started_at < $2::timestamptz AND COALESCE(sp.ended_at, 'infinity'::timestamptz) > $1::timestamptz
          GROUP BY 1, 2`,
        [start, end],
      ),
      query(
        `SELECT DISTINCT ${KEY_SQL('p')} AS project_key, e.task_key
           FROM task_events e JOIN projects p ON p.id = e.project_id
          WHERE e.to_status = 'done' AND e.ts >= $1::timestamptz AND e.ts < $2::timestamptz`,
        [start, end],
      ),
      query(
        `SELECT project_key, count(DISTINCT sha)::int AS n FROM (
           SELECT ${KEY_SQL('p')} AS project_key, c->>'sha' AS sha
             FROM project_snapshots ps JOIN projects p ON p.id = ps.project_id CROSS JOIN LATERAL jsonb_array_elements(ps.commits) c
            WHERE (c->>'ts')::bigint >= $3::bigint AND (c->>'ts')::bigint < $4::bigint
           UNION ALL
           SELECT ${KEY_SQL('p')}, tc.sha FROM task_commits tc JOIN projects p ON p.id = tc.project_id
            WHERE tc.committed_at >= $1::timestamptz AND tc.committed_at < $2::timestamptz
         ) x GROUP BY 1`,
        [start, end, start.getTime(), end.getTime()],
      ),
      query(
        `SELECT ${KEY_SQL('p')} AS project_key, tc.task_key, count(DISTINCT tc.sha)::int AS n
           FROM task_commits tc JOIN projects p ON p.id = tc.project_id
          WHERE tc.committed_at >= $1::timestamptz AND tc.committed_at < $2::timestamptz GROUP BY 1, 2`,
        [start, end],
      ),
      query(
        `SELECT DISTINCT ON (${KEY_SQL('p')}, t.task_key) ${KEY_SQL('p')} AS project_key, t.task_key, t.title, t.status, t.size
           FROM project_tasks t JOIN projects p ON p.id = t.project_id
          ORDER BY ${KEY_SQL('p')}, t.task_key, t.updated_at DESC`,
        [],
      ),
      this.sizeMap(),
    ]);

    const projectNames = new Map<string, string>();
    for (const p of projects) if (!projectNames.has(p['project_key'] as string)) projectNames.set(p['project_key'] as string, p['name'] as string);
    const clients: ClientRow[] = clientRows.map((c) => ({ id: c['id'] as string, name: c['name'] as string, hourlyRate: (c['hourly_rate'] as string | null) === null ? null : trimRate(c['hourly_rate'] as string), currency: c['currency'] as BillingCurrency }));
    const events: EventRow[] = eventRows.map((r) => ({
      sessionId: r['session_id'] as string,
      projectKey: (r['project_key'] as string | null) ?? null,
      ts: (r['ts'] as Date).getTime(),
      status: r['status'] as string,
      nextTs: r['next_ts'] ? (r['next_ts'] as Date).getTime() : null,
    }));
    const spans: SpanRow[] = spanRows.map((r) => ({
      sessionId: r['session_id'] as string,
      projectKey: r['project_key'] as string,
      taskKey: r['task_key'] as string,
      startMs: (r['started_at'] as Date).getTime(),
      endMs: r['ended_at'] ? (r['ended_at'] as Date).getTime() : null,
    }));
    const projectTokens = new Map<string, { tokens: TokenSums; costUsd: number | null }>();
    for (const r of projTok) {
      const key = (r['project_key'] as string | null) ?? UNKNOWN_PROJECT_KEY;
      const prev = projectTokens.get(key);
      const cost = r['cost'] === null ? null : Number(r['cost']);
      const t = tokens(r);
      projectTokens.set(key, prev ? { tokens: { input: prev.tokens.input + t.input, output: prev.tokens.output + t.output, cacheRead: prev.tokens.cacheRead + t.cacheRead, cacheCreation: prev.tokens.cacheCreation + t.cacheCreation }, costUsd: prev.costUsd === null ? cost : cost === null ? prev.costUsd : prev.costUsd + cost } : { tokens: t, costUsd: cost });
    }
    const taskTokens = new Map<string, { tokens: TokenSums; costUsd: number | null; sessions: number }>();
    for (const r of taskTok) taskTokens.set(taskId(r['project_key'] as string, r['task_key'] as string), { tokens: tokens(r), costUsd: r['cost'] === null ? null : Number(r['cost']), sessions: num(r['sessions']) });
    const taskInfo = new Map<string, TaskInfo>();
    for (const r of infoRows) taskInfo.set(taskId(r['project_key'] as string, r['task_key'] as string), { title: r['title'] as string, status: r['status'] as TaskInfo['status'], size: (r['size'] as string | null) ?? null });

    const dto = buildTimesheet({
      from,
      to,
      startMs: start.getTime(),
      endMs: end.getTime(),
      nowMs: now.getTime(),
      projectNames,
      clients,
      mapping: new Map(mappingRows.map((m) => [m['project_key'] as string, m['client_id'] as string] as const)),
      events,
      spans,
      projectTokens,
      taskTokens,
      closed: closed.map((c) => ({ projectKey: c['project_key'] as string, taskKey: c['task_key'] as string })),
      projectCommits: new Map(projCommits.map((c) => [c['project_key'] as string, num(c['n'])] as const)),
      taskCommits: new Map(taskCommits.map((c) => [taskId(c['project_key'] as string, c['task_key'] as string), num(c['n'])] as const)),
      taskInfo,
      sizeHours: (size) => estimateHours(size, sizeMap)?.hours ?? null,
      currency,
      fxUzsPerUsd: q.fxUzsPerUsd ?? null,
    });

    if (!q.clientId) return dto;
    const only = dto.clients.filter((c) => c.clientId === q.clientId);
    // Faqat tanlangan mijoz: jami = uning jami (boshqa mijozlar yig'indisiga qo'shilmaydi)
    return { ...dto, clients: only, total: only[0]?.totals ?? { ...dto.total, activeSeconds: 0, sessions: 0, tasksClosed: 0, commits: 0, costUsd: null, plannedSeconds: 0, plannedActualSeconds: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } };
  }

  private async sizeMap(): Promise<Record<string, number>> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [TASK_SIZE_HOURS_SETTING]);
    const parsed = SizeHoursSettingSchema.safeParse(rows[0]?.value);
    return parsed.success ? { ...DEFAULT_SIZE_HOURS, ...parsed.data } : { ...DEFAULT_SIZE_HOURS };
  }
}

/** `numeric(16,4)` matni ("150000.0000") -> eng qisqa o'nli ("150000", "12.5"). */
export function trimRate(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}
