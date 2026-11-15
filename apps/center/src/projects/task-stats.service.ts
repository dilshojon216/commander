import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UNATTRIBUTED_TASK_LABEL, partSlug } from '@commander/contracts';
import type { TaskStats, UnattributedTasks } from '@commander/contracts';
import { toTotals } from '../api/usage.service.js';

/** Xom `token_usage` retention'i (kun): vazifa tokenlari shu oynadan eskisini o'z ichiga olmaydi. */
export const RAW_USAGE_RETENTION_DAYS = 30;

/** Bitta `working` oralig'ining yuqori chegarasi: oxirgi hodisadan keyin indamay qolgan sessiya vaqtni cheksiz o'stirmasin. */
export const ACTIVE_INTERVAL_CAP_HOURS = 4;

export interface StatsScope {
  /** `null` = barcha loyihalar. */
  projectIds: string[] | null;
  from: Date | null;
  to: Date | null;
}

/** Qism filtri (6.15): `''` = ildiz, aks holda qism yo'li. `null` = filtrsiz. */
export type PartFilter = string;

export const statsKey = (projectId: string, taskKey: string): string => `${projectId}|${taskKey}`;

const SPAN_SCOPE = `($1::uuid[] IS NULL OR sp.project_id = ANY($1::uuid[])) AND sp.project_id IS NOT NULL
   AND sp.started_at < $3::timestamptz AND COALESCE(sp.ended_at, 'infinity'::timestamptz) > $2::timestamptz`;

const NUM_COLS = `sum(tu.input_tokens)::float8 AS input_tokens, sum(tu.output_tokens)::float8 AS output_tokens,
       sum(tu.cache_read_tokens)::float8 AS cache_read_tokens, sum(tu.cache_creation_tokens)::float8 AS cache_creation_tokens,
       sum(tu.cost_usd)::float8 AS cost_usd, count(*)::float8 AS requests`;

type Row = Record<string, unknown>;

/**
 * Vazifa bo'yicha statistika (task 2.9): span oynalaridagi `token_usage` + sessiyalar soni + `working` davomiyligi.
 * SQL indekslarga tayanadi: `uq/idx_task_spans_*`, `idx_token_usage_session_ts` (span bo'yicha nested loop), `idx_session_events_session_ts`.
 */
@Injectable()
export class TaskStatsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private params(scope: StatsScope): [string[] | null, string, string] {
    return [scope.projectIds, scope.from ? scope.from.toISOString() : '-infinity', scope.to ? scope.to.toISOString() : 'infinity'];
  }

  /** `(projectId|taskKey)` -> statistika. Faqat span'i bor vazifalar qaytadi. */
  async byTask(scope: StatsScope, now: Date = new Date()): Promise<Map<string, TaskStats>> {
    const params = this.params(scope);
    const [spans, tokens, active] = await Promise.all([
      this.dataSource.query(
        `SELECT sp.project_id, sp.task_key,
                count(DISTINCT (sp.machine_id, sp.session_id))::int AS sessions,
                min(sp.started_at) AS first_at,
                max(COALESCE(sp.ended_at, $4::timestamptz)) AS last_at,
                bool_or(sp.source = 'explicit') AS has_explicit,
                bool_or(sp.source = 'branch') AS has_branch
           FROM session_task_spans sp
          WHERE ${SPAN_SCOPE}
          GROUP BY 1, 2`,
        [...params, now],
      ) as Promise<Row[]>,
      this.dataSource.query(
        `SELECT sp.project_id, sp.task_key, ${NUM_COLS}, min(tu.ts) AS first_ts, max(tu.ts) AS last_ts
           FROM session_task_spans sp
           JOIN token_usage tu ON tu.machine_id = sp.machine_id AND tu.session_id = sp.session_id
            AND tu.ts >= GREATEST(sp.started_at, $2::timestamptz)
            AND tu.ts < LEAST(COALESCE(sp.ended_at, 'infinity'::timestamptz), $3::timestamptz)
          WHERE ${SPAN_SCOPE}
          GROUP BY 1, 2`,
        params,
      ) as Promise<Row[]>,
      this.dataSource.query(
        `WITH sp AS (
           SELECT sp.project_id, sp.task_key, sp.started_at, sp.ended_at, s.id AS sid
             FROM session_task_spans sp
             JOIN sessions s ON s.machine_id = sp.machine_id AND s.claude_session_id = sp.session_id
            WHERE ${SPAN_SCOPE}
         ), ev AS (
           SELECT e.session_id, e.ts, e.status,
                  lead(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS next_ts
             FROM session_events e
            WHERE e.session_id IN (SELECT sid FROM sp)
         )
         SELECT sp.project_id, sp.task_key,
                sum(GREATEST(0, EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(ev.next_ts, ev.ts + interval '${ACTIVE_INTERVAL_CAP_HOURS} hours'), ev.ts + interval '${ACTIVE_INTERVAL_CAP_HOURS} hours',
                        COALESCE(sp.ended_at, 'infinity'::timestamptz), $3::timestamptz)
                  - GREATEST(ev.ts, sp.started_at, $2::timestamptz)))))::float8 AS seconds
           FROM sp
           JOIN ev ON ev.session_id = sp.sid AND ev.status = 'working'
            AND ev.ts < LEAST(COALESCE(sp.ended_at, 'infinity'::timestamptz), $3::timestamptz)
            AND COALESCE(ev.next_ts, 'infinity'::timestamptz) > GREATEST(sp.started_at, $2::timestamptz)
          GROUP BY 1, 2`,
        params,
      ) as Promise<Row[]>,
    ]);

    const tokensBy = new Map(tokens.map((r) => [statsKey(r['project_id'] as string, r['task_key'] as string), r]));
    const activeBy = new Map(active.map((r) => [statsKey(r['project_id'] as string, r['task_key'] as string), Number(r['seconds'] ?? 0)]));
    const out = new Map<string, TaskStats>();
    for (const s of spans) {
      const key = statsKey(s['project_id'] as string, s['task_key'] as string);
      const t = tokensBy.get(key);
      const first = (t?.['first_ts'] as Date | undefined) ?? (s['first_at'] as Date);
      const last = (t?.['last_ts'] as Date | undefined) ?? (s['last_at'] as Date);
      const explicit = s['has_explicit'] === true;
      const branch = s['has_branch'] === true;
      out.set(key, {
        tokens: toTotals(t as Parameters<typeof toTotals>[0] | undefined),
        sessions: Number(s['sessions']),
        activeSeconds: Math.round(activeBy.get(key) ?? 0),
        firstActivityAt: first.toISOString(),
        lastActivityAt: last.toISOString(),
        source: explicit && branch ? 'mixed' : explicit ? 'explicit' : branch ? 'branch' : null,
      });
    }
    return out;
  }

  /** Oyna ichida span'i bor turli sessiyalar soni (kunlik jami: bir sessiya ikki vazifada ishlasa bir marta). */
  async sessionCount(scope: StatsScope, part: PartFilter | null = null): Promise<number> {
    const rows: Row[] = await this.dataSource.query(
      `SELECT count(DISTINCT (sp.machine_id, sp.session_id))::int AS n FROM session_task_spans sp WHERE ${SPAN_SCOPE}
          AND ($4::text IS NULL OR (CASE WHEN $4 = '' THEN position(':' in sp.task_key) = 0 ELSE starts_with(sp.task_key, $4 || ':') END))`,
      [...this.params(scope), part === null ? null : partSlug(part)],
    );
    return Number(rows[0]?.['n'] ?? 0);
  }

  /** Hech bir span'ga tushmagan tokenlar ("vazifasiz"). */
  async unattributed(scope: StatsScope, part: PartFilter | null = null): Promise<UnattributedTasks> {
    const [projectIds, from, to] = this.params(scope);
    const rows: Row[] = await this.dataSource.query(
      `SELECT ${NUM_COLS}, count(DISTINCT (tu.machine_id, tu.session_id))::int AS sessions
         FROM token_usage tu
        WHERE ($1::uuid[] IS NULL OR tu.project_id = ANY($1::uuid[]))
          AND tu.ts >= $2::timestamptz AND tu.ts < $3::timestamptz
          AND ($4::text IS NULL OR EXISTS (
            SELECT 1 FROM sessions ps WHERE ps.machine_id = tu.machine_id AND ps.claude_session_id = tu.session_id AND COALESCE(ps.part, '') = $4))
          AND NOT EXISTS (
            SELECT 1 FROM session_task_spans sp
             WHERE sp.machine_id = tu.machine_id AND sp.session_id = tu.session_id
               AND sp.started_at <= tu.ts AND (sp.ended_at IS NULL OR tu.ts < sp.ended_at))`,
      [projectIds, from, to, part],
    );
    const r = rows[0];
    return { label: UNATTRIBUTED_TASK_LABEL, tokens: toTotals(r as Parameters<typeof toTotals>[0] | undefined), sessions: Number(r?.['sessions'] ?? 0) };
  }
}
