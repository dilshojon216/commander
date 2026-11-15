import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TASHKENT_TZ, USAGE_RANGE_LIMITS_MS, isQueryFlagTrue } from '@commander/contracts';
import type {
  ArchivedProjectsSummary,
  ListProjectsQuery,
  ListProjectsResponse,
  ProjectDto,
  TokenTotals,
  UsageBucket,
  UsageGroupBy,
  UsagePoint,
  UsageQuery,
  UsageResponse,
  UsageSeries,
  UsageSummaryPeriod,
  UsageSummaryResponse,
} from '@commander/contracts';
import { selectUsageSource, validateRange } from './usage-source.js';

const SUM_COLS = `sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens,
  sum(cache_read_tokens)::float8 AS cache_read_tokens, sum(cache_creation_tokens)::float8 AS cache_creation_tokens,
  sum(cost_usd)::float8 AS cost_usd, sum(requests)::float8 AS requests`;

interface TotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  requests: number | null;
}

export function toTotals(r: Partial<TotalsRow> | undefined): TokenTotals {
  const input = r?.input_tokens ?? 0;
  const output = r?.output_tokens ?? 0;
  const cacheRead = r?.cache_read_tokens ?? 0;
  const cacheCreation = r?.cache_creation_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    totalTokens: input + output + cacheRead + cacheCreation,
    costUsd: r?.cost_usd ?? null,
    requests: r?.requests ?? 0,
  };
}

const BUCKET_SQL: Record<UsageBucket, string> = { '5m': `INTERVAL '5 minutes'`, '1h': `INTERVAL '1 hour'`, '1d': `INTERVAL '1 day'` };

const addTotals = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  requests: a.requests + b.requests,
});

@Injectable()
export class UsageService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // --- GET /v1/usage ---------------------------------------------------------------------------

  async series(q: UsageQuery, now: Date = new Date()): Promise<UsageResponse> {
    const limits = USAGE_RANGE_LIMITS_MS[q.bucket];
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - limits.default);
    const rangeError = validateRange(from, to, limits.max);
    if (rangeError) throw new BadRequestException({ error: 'invalid_request', message: rangeError });

    const plan = selectUsageSource(q.bucket, q.groupBy, { machine: q.machine !== undefined, project: q.project !== undefined });
    const params: unknown[] = [from, to];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    const interval = BUCKET_SQL[q.bucket];
    const tz = q.bucket === '1d' ? `, '${TASHKENT_TZ}'` : '';
    const machineFilter = (col: string): string => (q.machine ? ` AND ${col} IN (SELECT id FROM machines WHERE id::text = ${add(q.machine)} OR slug = ${add(q.machine)})` : '');
    const projectFilter = q.project ? ` AND project_id = ${add(q.project)}::uuid` : '';
    const keyExpr = (machineCol: boolean, projectCol: boolean): string => {
      switch (q.groupBy) {
        case 'machine':
          return machineCol ? `machine_id::text` : `NULL::text`;
        case 'project':
          return projectCol ? `COALESCE(project_id::text, 'unknown')` : `NULL::text`;
        case 'model':
          return `model`;
        default:
          return `NULL::text`;
      }
    };

    let sql: string;
    if (plan.source === 'usage_5m' || plan.source === 'usage_1h') {
      const bucketExpr = plan.rebucketDaily ? `time_bucket(INTERVAL '1 day', bucket, '${TASHKENT_TZ}')` : 'bucket';
      sql = `SELECT ${bucketExpr} AS t, ${keyExpr(true, false)} AS key, ${SUM_COLS}
               FROM ${plan.source}
              WHERE bucket >= time_bucket(${interval}, $1::timestamptz${tz}) AND bucket < $2::timestamptz ${machineFilter('machine_id')}
              GROUP BY 1, 2 ORDER BY 1`;
    } else if (plan.source === 'daily_by_project') {
      sql = `SELECT day AS t, ${keyExpr(false, true)} AS key, ${SUM_COLS}
               FROM token_usage_daily_by_project
              WHERE day >= time_bucket(INTERVAL '1 day', $1::timestamptz, '${TASHKENT_TZ}') AND day < $2::timestamptz ${projectFilter}
              GROUP BY 1, 2 ORDER BY 1`;
    } else {
      sql = `SELECT time_bucket(${interval}, ts${tz}) AS t, ${keyExpr(true, true)} AS key,
                    sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens,
                    sum(cache_read_tokens)::float8 AS cache_read_tokens, sum(cache_creation_tokens)::float8 AS cache_creation_tokens,
                    sum(cost_usd)::float8 AS cost_usd, count(*)::float8 AS requests
               FROM token_usage
              WHERE ts >= time_bucket(${interval}, $1::timestamptz${tz}) AND ts < $2::timestamptz ${machineFilter('machine_id')} ${projectFilter}
              GROUP BY 1, 2 ORDER BY 1`;
    }
    const rows: Array<{ t: Date; key: string | null } & TotalsRow> = await this.dataSource.query(sql, params);

    const byKey = new Map<string | null, UsagePoint[]>();
    for (const r of rows) {
      const t = toTotals(r);
      const point: UsagePoint = {
        t: r.t.toISOString(),
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheCreationTokens: t.cacheCreationTokens,
        costUsd: t.costUsd,
        requests: t.requests,
      };
      const list = byKey.get(r.key) ?? [];
      list.push(point);
      byKey.set(r.key, list);
    }
    const labels = await this.labels(q.groupBy, [...byKey.keys()].filter((k): k is string => k !== null));
    const series: UsageSeries[] = [...byKey.entries()].map(([key, points]) => ({
      key,
      label: key === null ? 'total' : (labels.get(key) ?? key),
      points,
      total: points.reduce<TokenTotals>(
        (acc, p) => addTotals(acc, { ...p, totalTokens: p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens }),
        toTotals(undefined),
      ),
    }));
    series.sort((a, b) => b.total.totalTokens - a.total.totalTokens);
    return { bucket: q.bucket, from: from.toISOString(), to: to.toISOString(), groupBy: q.groupBy, timezone: TASHKENT_TZ, source: plan.source, series };
  }

  private async labels(groupBy: UsageGroupBy, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    if (groupBy === 'machine') {
      const rows: Array<{ id: string; slug: string }> = await this.dataSource.query(`SELECT id::text AS id, slug FROM machines WHERE id::text = ANY($1::text[])`, [keys]);
      for (const r of rows) out.set(r.id, r.slug);
    } else if (groupBy === 'project') {
      const rows: Array<{ id: string; name: string }> = await this.dataSource.query(`SELECT id::text AS id, name FROM projects WHERE id::text = ANY($1::text[])`, [keys]);
      for (const r of rows) out.set(r.id, r.name);
      if (keys.includes('unknown')) out.set('unknown', 'unknown');
    }
    return out;
  }

  // --- GET /v1/usage/summary -------------------------------------------------------------------

  async summary(now: Date = new Date()): Promise<UsageSummaryResponse> {
    const periods = [
      ['today', '0 days'],
      ['last7d', '6 days'],
      ['last30d', '29 days'],
    ] as const;
    const cols = periods
      .map(([name, back]) =>
        ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'requests']
          .map((c) => `sum(${c}) FILTER (WHERE day >= t.today - INTERVAL '${back}')::float8 AS ${name}_${c}`)
          .join(', '),
      )
      .join(', ');
    const all = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'cost_usd', 'requests'].map((c) => `sum(${c})::float8 AS all_${c}`).join(', ');
    const rows: Array<Record<string, number | null | Date>> = await this.dataSource.query(
      `WITH t AS (SELECT time_bucket(INTERVAL '1 day', $1::timestamptz, '${TASHKENT_TZ}') AS today)
       SELECT t.today AS today_start, ${cols}, ${all} FROM token_usage_daily_total d, t GROUP BY t.today`,
      [now],
    );
    const todayRows: Array<{ today: Date }> = await this.dataSource.query(`SELECT time_bucket(INTERVAL '1 day', $1::timestamptz, '${TASHKENT_TZ}') AS today`, [now]);
    const todayStart = todayRows[0]!.today;
    const row = rows[0];
    const pick = (prefix: string): TokenTotals =>
      toTotals(
        row
          ? {
              input_tokens: row[`${prefix}_input_tokens`] as number | null,
              output_tokens: row[`${prefix}_output_tokens`] as number | null,
              cache_read_tokens: row[`${prefix}_cache_read_tokens`] as number | null,
              cache_creation_tokens: row[`${prefix}_cache_creation_tokens`] as number | null,
              cost_usd: row[`${prefix}_cost_usd`] as number | null,
              requests: row[`${prefix}_requests`] as number | null,
            }
          : undefined,
      );
    const period = (prefix: string, back: number | null): UsageSummaryPeriod => ({
      from: back === null ? null : new Date(todayStart.getTime() - back * 86_400_000).toISOString(),
      totals: pick(prefix),
    });
    return {
      today: period('today', 0),
      last7d: period('last7d', 6),
      last30d: period('last30d', 29),
      allTime: period('all', null),
      timezone: TASHKENT_TZ,
      costKind: 'api_equivalent',
    };
  }

  // --- GET /v1/projects ------------------------------------------------------------------------

  async projects(q: ListProjectsQuery, now: Date = new Date()): Promise<ListProjectsResponse> {
    return this.loadProjects({ machine: q.machine, limit: q.limit, archived: isQueryFlagTrue(q.archived) }, now);
  }

  /** Bitta loyiha (`GET /v1/projects/:id` uchun); yo'q bo'lsa `null`. Arxivlangan loyiha ham qaytadi (`archivedAt` bilan). */
  async projectById(id: string, now: Date = new Date()): Promise<ProjectDto | null> {
    const r = await this.loadProjects({ projectId: id, limit: 1 }, now);
    return r.items[0] ?? null;
  }

  /**
   * `archived`: `false` = faqat faollar (default), `true` = faqat arxivlanganlar; `projectId` berilsa filtr yo'q (detail arxivlangan loyihada ham ishlaydi).
   * `archived` yig'indisi (jami hisobga kiradi, ro'yxatda yo'q) har doim hisoblanadi.
   */
  private async loadProjects(q: { machine?: string | undefined; projectId?: string | undefined; limit: number; archived?: boolean }, now: Date): Promise<ListProjectsResponse> {
    const minutes = this.config.get<number>('STALE_MINUTES') ?? 720;
    const cutoff = new Date(now.getTime() - minutes * 60_000);
    const todayRows: Array<{ today: Date }> = await this.dataSource.query(`SELECT time_bucket(INTERVAL '1 day', $1::timestamptz, '${TASHKENT_TZ}') AS today`, [now]);
    const todayStart = todayRows[0]!.today;

    // `last_used_at`: kunlik cagg'da kun boshi (Asia/Tashkent) — hamma loyiha bir xil ko'rinardi; shuning uchun sessiyalarning eng yangi
    // `last_seen_at` bilan GREATEST (NULL'larni o'tkazib yuboradi) olinadi.
    const rows: Array<
      {
        id: string;
        machine_id: string;
        machine_slug: string;
        name: string;
        path: string;
        repo_key: string | null;
        kind: 'git' | 'dir';
        first_used_at: Date | null;
        last_used_at: Date | null;
        open_sessions: number;
        archived_at: Date | null;
      } & Record<string, unknown>
    > = await this.dataSource.query(
      `WITH today AS (
         SELECT project_id, ${SUM_COLS} FROM token_usage_daily_by_project WHERE day >= $1::timestamptz GROUP BY project_id
       ), totals AS (
         SELECT project_id, ${SUM_COLS}, min(day) AS first_used_at, max(day) AS last_used_at
           FROM token_usage_daily_by_project WHERE project_id IS NOT NULL GROUP BY project_id
       )
       SELECT p.id, p.machine_id, m.slug AS machine_slug, p.name, p.path, p.repo_key, p.kind,
              t.input_tokens AS t_input_tokens, t.output_tokens AS t_output_tokens, t.cache_read_tokens AS t_cache_read_tokens,
              t.cache_creation_tokens AS t_cache_creation_tokens, t.cost_usd AS t_cost_usd, t.requests AS t_requests,
              a.input_tokens AS a_input_tokens, a.output_tokens AS a_output_tokens, a.cache_read_tokens AS a_cache_read_tokens,
              a.cache_creation_tokens AS a_cache_creation_tokens, a.cost_usd AS a_cost_usd, a.requests AS a_requests,
              a.first_used_at,
              GREATEST(a.last_used_at, (SELECT max(s.last_seen_at) FROM sessions s WHERE s.project_id = p.id)) AS last_used_at,
              (SELECT count(*)::int FROM sessions s WHERE s.project_id = p.id AND s.ended_at IS NULL AND s.status <> 'ended' AND s.last_seen_at >= $2) AS open_sessions,
              p.archived_at
         FROM projects p
         JOIN machines m ON m.id = p.machine_id
         LEFT JOIN today t ON t.project_id = p.id
         LEFT JOIN totals a ON a.project_id = p.id
        WHERE ($3::text IS NULL OR m.id::text = $3 OR m.slug = $3) AND ($5::uuid IS NULL OR p.id = $5::uuid)
          AND ($5::uuid IS NOT NULL OR (p.archived_at IS NOT NULL) = $6::boolean)
        ORDER BY COALESCE(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens, 0) DESC,
                 COALESCE(a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_creation_tokens, 0) DESC, p.name
        LIMIT $4`,
      [todayStart, cutoff, q.machine ?? null, q.limit, q.projectId ?? null, q.archived ?? false],
    );

    const unattr: Array<Record<string, number | null>> = await this.dataSource.query(
      `SELECT ${SUM_COLS} FROM token_usage_daily_by_project WHERE project_id IS NULL`,
    );
    const unattrToday: Array<Partial<TotalsRow>> = await this.dataSource.query(
      `SELECT ${SUM_COLS} FROM token_usage_daily_by_project WHERE project_id IS NULL AND day >= $1::timestamptz`,
      [todayStart],
    );

    const pickRow = (r: Record<string, unknown>, p: string): TokenTotals =>
      toTotals({
        input_tokens: r[`${p}_input_tokens`] as number | null,
        output_tokens: r[`${p}_output_tokens`] as number | null,
        cache_read_tokens: r[`${p}_cache_read_tokens`] as number | null,
        cache_creation_tokens: r[`${p}_cache_creation_tokens`] as number | null,
        cost_usd: r[`${p}_cost_usd`] as number | null,
        requests: r[`${p}_requests`] as number | null,
      });
    const items: ProjectDto[] = rows.map((r) => ({
      id: r.id,
      machineId: r.machine_id,
      machineSlug: r.machine_slug,
      name: r.name,
      path: r.path,
      repoKey: r.repo_key,
      kind: r.kind,
      today: pickRow(r, 't'),
      allTime: pickRow(r, 'a'),
      firstUsedAt: r.first_used_at ? r.first_used_at.toISOString() : null,
      lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
      openSessions: r.open_sessions,
      archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    }));
    return {
      items,
      archived: await this.archivedSummary(todayStart, q.machine),
      unattributed: { today: toTotals(unattrToday[0]), allTime: toTotals(unattr[0] as Partial<TotalsRow> | undefined) },
      todayStart: todayStart.toISOString(),
      timezone: TASHKENT_TZ,
    };
  }

  /** 6.16: arxivlangan loyihalar tokenlari (kunlik cagg'dan): jami hisoblar to'g'ri qolsin, ro'yxat/reytingda yashirin. */
  private async archivedSummary(todayStart: Date, machine: string | undefined): Promise<ArchivedProjectsSummary> {
    const scope = `SELECT p.id FROM projects p WHERE p.archived_at IS NOT NULL AND ($1::text IS NULL OR p.machine_id::text = $1 OR p.machine_id IN (SELECT id FROM machines WHERE slug = $1))`;
    const [count, all, today]: [Array<{ n: number }>, Array<Partial<TotalsRow>>, Array<{ machine_id: string } & Partial<TotalsRow>>] = await Promise.all([
      this.dataSource.query(`SELECT count(*)::int AS n FROM (${scope}) a`, [machine ?? null]),
      this.dataSource.query(`SELECT ${SUM_COLS} FROM token_usage_daily_by_project WHERE project_id IN (${scope})`, [machine ?? null]),
      this.dataSource.query(
        `SELECT p.machine_id, ${SUM_COLS.replace(/sum\((\w+)\)/g, 'sum(d.$1)')}
           FROM token_usage_daily_by_project d JOIN projects p ON p.id = d.project_id
          WHERE d.day >= $2::timestamptz AND d.project_id IN (${scope}) GROUP BY p.machine_id`,
        [machine ?? null, todayStart],
      ),
    ]);
    const byMachine = today.map((r) => ({ machineId: r.machine_id, totals: toTotals(r) }));
    return {
      count: count[0]?.n ?? 0,
      today: byMachine.reduce<TokenTotals>((acc, m) => addTotals(acc, m.totals), toTotals(undefined)),
      allTime: toTotals(all[0]),
      todayByMachine: byMachine.map((m) => ({ machineId: m.machineId, totalTokens: m.totals.totalTokens })),
    };
  }
}
