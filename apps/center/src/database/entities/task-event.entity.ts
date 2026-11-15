import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Vazifa holati o'zgarishlari jurnali: `tasks_md` (snapshot farqi) yoki `board` (doskada surilgan). */
@Entity('task_events')
export class TaskEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint', name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'text', name: 'task_key' })
  taskKey: string;

  @Column({ type: 'text', name: 'from_status', nullable: true })
  fromStatus: string | null;

  @Column({ type: 'text', name: 'to_status' })
  toStatus: string;

  @Column({ type: 'text', name: 'source' })
  source: 'tasks_md' | 'board';

  @Column({ type: 'uuid', name: 'device_id', nullable: true })
  deviceId: string | null;

  @Column({ type: 'timestamptz', name: 'ts', default: () => 'now()' })
  ts: Date;
}
