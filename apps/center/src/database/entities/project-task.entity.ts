import { Column, Entity, PrimaryColumn } from 'typeorm';

export const PROJECT_TASK_STATUS_VALUES = ['todo', 'doing', 'done', 'unknown'] as const;

/** Oxirgi snapshot'dagi TASKS.md jadvalidan server tomonda parse qilingan vazifa (har snapshot'da almashtiriladi). */
@Entity('project_tasks')
export class ProjectTask {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @PrimaryColumn({ type: 'text', name: 'task_key' })
  taskKey: string;

  @Column({ type: 'text', name: 'title' })
  title: string;

  @Column({ type: 'text', name: 'phase', nullable: true })
  phase: string | null;

  @Column({ type: 'text', name: 'status' })
  status: (typeof PROJECT_TASK_STATUS_VALUES)[number];

  @Column({ type: 'text', name: 'raw_status', nullable: true })
  rawStatus: string | null;

  @Column({ type: 'integer', name: 'order' })
  order: number;

  @Column({ type: 'text', name: 'size', nullable: true })
  size: string | null;

  /** Qism (6.15): '' = ildiz; aks holda ildizga nisbiy papka. Qism vazifasining `taskKey` i `<slug>:<id>`. */
  @Column({ type: 'text', name: 'part', default: '' })
  part: string;

  /** Bajarilgan sana (fayl sarlavhasidan; faqat qism vazifalari). */
  @Column({ type: 'date', name: 'done_on', nullable: true })
  doneOn: string | null;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}
