import { Column, Entity, PrimaryColumn } from 'typeorm';

export const LIMIT_SOURCES = ['official', 'estimate'] as const;
export type LimitSource = (typeof LIMIT_SOURCES)[number];

/**
 * Hypertable. Har oyna maydoni ixtiyoriy (S2: `five_hour` faol bo'lmaganda umuman
 * kelmaydi). `source` majburiy: taxminni rasmiy raqamdek ko'rsatmaslik (CLAUDE.md #6).
 */
@Entity('limit_samples')
export class LimitSample {
  @PrimaryColumn({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @PrimaryColumn({ type: 'text', name: 'source' })
  source: LimitSource;

  @PrimaryColumn({ type: 'timestamptz', name: 'ts' })
  ts: Date;

  @Column({ type: 'text', name: 'session_id', nullable: true })
  sessionId: string | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'five_hour_used_pct', nullable: true })
  fiveHourUsedPct: string | null;

  @Column({ type: 'timestamptz', name: 'five_hour_resets_at', nullable: true })
  fiveHourResetsAt: Date | null;

  @Column({ type: 'numeric', precision: 6, scale: 2, name: 'seven_day_used_pct', nullable: true })
  sevenDayUsedPct: string | null;

  @Column({ type: 'timestamptz', name: 'seven_day_resets_at', nullable: true })
  sevenDayResetsAt: Date | null;

  @Column({ type: 'jsonb', name: 'calibration', nullable: true })
  calibration: Record<string, unknown> | null;
}
