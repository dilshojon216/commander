import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { checkRetentionInvariants } from './retention-policy.js';
import type { JobRow } from './retention-policy.js';

/** Hisobot uchun jadvallar (faqat qatorlar soni, mazmun emas). */
export const COUNTED_TABLES = ['session_events', 'token_usage', 'machine_health', 'limit_samples', 'approvals', 'session_messages', 'reports', 'commands', 'audit_log'] as const;

export interface RetentionStatus {
  jobs: JobRow[];
  problems: string[];
  counts: Record<string, number>;
  /** Siqilgan va siqilmagan chunk soni (hypertable bo'yicha). */
  chunks: Array<{ table: string; total: number; compressed: number }>;
}

/** TimescaleDB siyosatlarini o'qiydi va 5.2 invariantlarini tekshiradi (o'zgartirmaydi: siyosatlar migratsiyada). */
@Injectable()
export class RetentionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async jobs(): Promise<JobRow[]> {
    return this.dataSource.query(`
      SELECT j.proc_name, COALESCE(c.view_name, j.hypertable_name) AS target, j.config
        FROM timescaledb_information.jobs j
        LEFT JOIN timescaledb_information.continuous_aggregates c ON c.materialization_hypertable_name = j.hypertable_name
       WHERE j.proc_name IN ('policy_retention', 'policy_compression', 'policy_refresh_continuous_aggregate', 'commander_retention_sweep')
       ORDER BY 1, 2`);
  }

  async problems(): Promise<string[]> {
    return checkRetentionInvariants(await this.jobs());
  }

  async status(): Promise<RetentionStatus> {
    const jobs = await this.jobs();
    const counts: Record<string, number> = {};
    for (const t of COUNTED_TABLES) {
      const rows: Array<{ n: string }> = await this.dataSource.query(`SELECT count(*)::text AS n FROM "${t}"`);
      counts[t] = Number(rows[0]?.n ?? 0);
    }
    const chunks: Array<{ table: string; total: string; compressed: string }> = await this.dataSource.query(`
      SELECT hypertable_name AS "table", count(*)::text AS total, count(*) FILTER (WHERE is_compressed)::text AS compressed
        FROM timescaledb_information.chunks WHERE hypertable_name IN ('session_events', 'token_usage', 'machine_health', 'limit_samples')
       GROUP BY 1 ORDER BY 1`);
    return {
      jobs,
      problems: checkRetentionInvariants(jobs),
      counts,
      chunks: chunks.map((c) => ({ table: c.table, total: Number(c.total), compressed: Number(c.compressed) })),
    };
  }
}

/** Faqat server jarayonida: boot'da invariantlarni tekshiradi va buzilganini logga yozadi (CLI bu hook'ni ishga tushirmaydi). */
@Injectable()
export class RetentionBootCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionBootCheck.name);

  constructor(private readonly retention: RetentionService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const problems = await this.retention.problems();
      if (problems.length === 0) this.logger.log('Retention/compression policies verified');
      for (const p of problems) this.logger.warn(`Retention invariant violated: ${p}`);
    } catch (err) {
      this.logger.warn(`Retention check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
