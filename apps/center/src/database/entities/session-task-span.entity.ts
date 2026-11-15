import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Sessiyaning vazifaga bog'langan vaqt oralig'i. `source`: `explicit` (/task, #task:) yoki `branch` (taxmin).
 * `session_id` = Claude sessiya id'si (`token_usage.session_id` bilan bir xil). Bir sessiyada bitta ochiq span (`ended_at IS NULL`).
 */
@Entity('session_task_spans')
export class SessionTaskSpan {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'text', name: 'session_id' })
  sessionId: string;

  @Column({ type: 'uuid', name: 'project_id', nullable: true })
  projectId: string | null;

  @Column({ type: 'text', name: 'task_key' })
  taskKey: string;

  @Column({ type: 'text', name: 'source' })
  source: 'explicit' | 'branch';

  @Column({ type: 'timestamptz', name: 'started_at' })
  startedAt: Date;

  @Column({ type: 'timestamptz', name: 'ended_at', nullable: true })
  endedAt: Date | null;
}
