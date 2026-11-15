import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Claude'ning kun xulosasi va vazifa baholari (bir loyiha + kun + qism = bitta qator). */
@Entity('daily_summaries')
export class DailySummary {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @PrimaryColumn({ type: 'date', name: 'day' })
  day: string;

  /** '' = butun loyiha / ildiz (6.18); aks holda qism yo'li. */
  @PrimaryColumn({ type: 'text', name: 'part', default: '' })
  part: string;

  @Column({ type: 'text', name: 'summary' })
  summary: string;

  @Column({ type: 'jsonb', name: 'scores', default: () => "'[]'" })
  scores: Array<{ taskKey: string; score: number; reason: string }>;

  @Column({ type: 'text', name: 'model' })
  model: string;

  @Column({ type: 'uuid', name: 'command_id', nullable: true })
  commandId: string | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;
}
