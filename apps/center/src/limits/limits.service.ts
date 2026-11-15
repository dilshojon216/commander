import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { LimitsResponse, WeeklyPace } from '@commander/contracts';
import { tashkentDayOf } from '../projects/tashkent-day.js';
import { FRESH_SECONDS, SAME_WINDOW_TOLERANCE_MS, computeWindowView, fitCalibration, weightedTokens } from './limits-logic.js';
import { FORECAST_BASIS_MINUTES, forecastWindow } from './forecast-logic.js';
import { computePace, resolveDayStart, windowBounds } from './pace-logic.js';
import type { SamplePoint } from './pace-logic.js';
import { loadPaceState } from './pace-store.js';
import type { CalibrationPoint, OfficialObservation, UsageBucket, WindowKind } from './limits-logic.js';

/** Oyna ustunlari (whitelist: SQL'ga faqat shu qiymatlar qo'yiladi). */
const COLUMNS: Record<WindowKind, { pct: string; resets: string }> = {
  fiveHour: { pct: 'five_hour_used_pct', resets: 'five_hour_resets_at' },
  sevenDay: { pct: 'seven_day_used_pct', resets: 'seven_day_resets_at' },
};

interface SumsRow {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const SUMS = `COALESCE(sum(input_tokens), 0)::float8 AS input, COALESCE(sum(output_tokens), 0)::float8 AS output,
              COALESCE(sum(cache_read_tokens), 0)::float8 AS cache_read, COALESCE(sum(cache_creation_tokens), 0)::float8 AS cache_creation`;

const weightedRow = (r: SumsRow): number => weightedTokens({ input: r.input, output: r.output, cacheRead: r.cache_read, cacheCreation: r.cache_creation });

/** Limit holati (`GET /v1/limits`, `/ws/client` `limits.updated`). Mantiq: `limits-logic.ts`. */
@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async current(now: Date = new Date()): Promise<LimitsResponse> {
    const [fiveHour, sevenDay] = await Promise.all([this.window('fiveHour', now), this.window('sevenDay', now)]);
    // 6.12: haftalik tezlik (additiv). Xato bo'lsa qolgan limit javobi buzilmaydi.
    const pace = await this.weeklyPace(sevenDay, now).catch((err: unknown) => {
      this.logger.warn(`weekly pace failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    return { computedAt: now.toISOString(), freshSeconds: FRESH_SECONDS, fiveHour, sevenDay, pace };
  }

  /** 6.12: kun boshidagi foiz `limit_samples` dan (rasmiy, shu oyna), sozlamalar/ogohlantirishlar `settings`/`pace_alerts` dan. */
  private async weeklyPace(view: LimitsResponse['sevenDay'], now: Date): Promise<WeeklyPace | null> {
    if (!view || !view.resetsAt) return null;
    const bounds = windowBounds(now, new Date(view.resetsAt));
    const [state, alerts] = await Promise.all([
      loadPaceState(this.dataSource, now),
      this.dataSource.query(`SELECT level, created_at FROM pace_alerts WHERE day = $1::date`, [tashkentDayOf(now)]) as Promise<Array<{ level: 'soft' | 'hard'; created_at: Date }>>,
    ]);
    let prev: SamplePoint | null = null;
    let firstToday: SamplePoint | null = null;
    if (bounds.windowStart.getTime() < bounds.midnight.getTime()) {
      const lo = new Date(bounds.resetsAt.getTime() - SAME_WINDOW_TOLERANCE_MS);
      const hi = new Date(bounds.resetsAt.getTime() + SAME_WINDOW_TOLERANCE_MS);
      const floor = new Date(bounds.windowStart.getTime() - SAME_WINDOW_TOLERANCE_MS);
      const [p, f]: Array<Array<{ ts: Date; pct: number }>> = await Promise.all([
        this.dataSource.query(
          `SELECT ts, seven_day_used_pct::float8 AS pct FROM limit_samples
            WHERE source = 'official' AND seven_day_used_pct IS NOT NULL AND seven_day_resets_at BETWEEN $1 AND $2 AND ts >= $3 AND ts <= $4
            ORDER BY ts DESC LIMIT 1`,
          [lo, hi, floor, bounds.midnight],
        ),
        this.dataSource.query(
          `SELECT ts, seven_day_used_pct::float8 AS pct FROM limit_samples
            WHERE source = 'official' AND seven_day_used_pct IS NOT NULL AND seven_day_resets_at BETWEEN $1 AND $2 AND ts > $3 AND ts <= $4
            ORDER BY ts ASC LIMIT 1`,
          [lo, hi, bounds.midnight, now],
        ),
      ]);
      prev = p[0] ? { at: p[0].ts, pct: p[0].pct } : null;
      firstToday = f[0] ? { at: f[0].ts, pct: f[0].pct } : null;
    }
    const at = (level: 'soft' | 'hard'): Date | null => alerts.find((a) => a.level === level)?.created_at ?? null;
    return computePace({
      now,
      view,
      dayStart: resolveDayStart(bounds, prev, firstToday),
      settings: state.settings,
      overriddenToday: state.overriddenToday,
      alertsToday: { soft: at('soft'), hard: at('hard') },
    });
  }

  private async window(kind: WindowKind, now: Date): Promise<LimitsResponse['fiveHour']> {
    const { pct, resets } = COLUMNS[kind];
    const latestRows: Array<{ ts: Date; machine_id: string; pct: number; resets: Date }> = await this.dataSource.query(
      `SELECT ts, machine_id, ${pct}::float8 AS pct, ${resets} AS resets
         FROM limit_samples
        WHERE source = 'official' AND ${pct} IS NOT NULL AND ${resets} IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
    );
    const row = latestRows[0];
    if (!row) return null;
    const latest: OfficialObservation = { observedAt: row.ts, usedPct: row.pct, resetsAt: row.resets, machineId: row.machine_id };

    const calibration = fitCalibration(await this.calibrationPoints(kind, latest));
    const reset = latest.resetsAt.getTime() <= now.getTime();

    const weightedSinceObserved = reset ? 0 : await this.weightedSince(latest.observedAt);
    const bucketsSinceReset = reset ? await this.bucketsSince(kind, latest.resetsAt, now) : [];
    const view = computeWindowView({ kind, now, latest, calibration, weightedSinceObserved, bucketsSinceReset });
    if (!view) return null;
    // 3.1: tugash vaqti bashorati (oxirgi oraliqdagi sarf tezligidan; yetarli ma'lumot yo'q bo'lsa null)
    const basis = await this.weightedSince(new Date(now.getTime() - FORECAST_BASIS_MINUTES[kind] * 60_000));
    return { ...view, forecast: forecastWindow({ kind, now, view, basisWeightedTokens: basis }) };
  }

  /** Joriy oynadagi (bir xil `resets_at`) oxirgi ~200 rasmiy kuzatuv va oraliqdagi vaznli tokenlar. */
  private async calibrationPoints(kind: WindowKind, latest: OfficialObservation): Promise<CalibrationPoint[]> {
    const { pct, resets } = COLUMNS[kind];
    const samples: Array<{ ts: Date; pct: number }> = await this.dataSource.query(
      `SELECT ts, ${pct}::float8 AS pct FROM limit_samples
        WHERE source = 'official' AND ${pct} IS NOT NULL AND ${resets} = $1
        ORDER BY ts DESC LIMIT 200`,
      [latest.resetsAt],
    );
    if (samples.length < 2) return [];
    // Bir xil ts bir necha mashinadan kelsa ham mos (ts bo'yicha tartib; pct bir xil akkaunt qiymati).
    const asc = samples.reverse();
    const times = asc.map((s) => s.ts);
    const sums: Array<{ t: Date } & SumsRow> = await this.dataSource.query(
      `WITH pts AS (SELECT t, lag(t) OVER (ORDER BY t) AS prev FROM unnest($1::timestamptz[]) AS t)
       SELECT pts.t AS t,
              COALESCE(sum(u.input_tokens), 0)::float8 AS input, COALESCE(sum(u.output_tokens), 0)::float8 AS output,
              COALESCE(sum(u.cache_read_tokens), 0)::float8 AS cache_read, COALESCE(sum(u.cache_creation_tokens), 0)::float8 AS cache_creation
         FROM pts
         LEFT JOIN token_usage u ON pts.prev IS NOT NULL AND u.ts > pts.prev AND u.ts <= pts.t AND u.ts > $2 AND u.ts <= $3
        GROUP BY pts.t ORDER BY pts.t`,
      [times, times[0], times[times.length - 1]],
    );
    const byTime = new Map(sums.map((s) => [s.t.getTime(), s] as const));
    return asc.map((s, i) => ({
      observedAt: s.ts,
      usedPct: s.pct,
      resetsAt: latest.resetsAt,
      weightedSincePrev: i === 0 ? null : (byTime.has(s.ts.getTime()) ? weightedRow(byTime.get(s.ts.getTime())!) : null),
    }));
  }

  private async weightedSince(since: Date): Promise<number> {
    const rows: SumsRow[] = await this.dataSource.query(`SELECT ${SUMS} FROM token_usage WHERE ts > $1`, [since]);
    return rows[0] ? weightedRow(rows[0]) : 0;
  }

  /** Reset'dan keyingi 5 daqiqalik bucket'lar (barcha mashinalar); real-time cagg (hali materializatsiya qilinmagan qism ham bor). */
  private async bucketsSince(kind: WindowKind, resetsAt: Date, now: Date): Promise<UsageBucket[]> {
    // Haftalik: boshi resetsAt dan keyingi 7 kunlik qadam; shuning uchun kamida 8 kun orqaga yetarli. Cheklov: 8 kun.
    const floor = new Date(Math.max(resetsAt.getTime() - 300_000, now.getTime() - 8 * 24 * 3_600_000));
    const rows: Array<{ t: Date } & SumsRow> = await this.dataSource.query(
      `SELECT bucket AS t, ${SUMS} FROM usage_5m WHERE bucket >= $1 AND bucket <= $2 GROUP BY bucket ORDER BY bucket`,
      [floor, now],
    );
    void kind;
    return rows.map((r) => ({ t: r.t, weighted: weightedRow(r) }));
  }
}
