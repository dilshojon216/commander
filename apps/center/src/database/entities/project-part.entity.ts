import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Loyiha qismi (6.15): monorepo papkasi va uning reja fayllari progressi (agentd hisoblagan sanoq). */
@Entity('project_parts')
export class ProjectPart {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  /** Ildizga nisbiy yo'l (`web-app`, `apps/center`). Ildiz ('') bu jadvalda YO'Q. */
  @PrimaryColumn({ type: 'text', name: 'part' })
  part: string;

  @Column({ type: 'text', name: 'name' })
  name: string;

  @Column({ type: 'jsonb', name: 'plan_files', default: () => "'[]'::jsonb" })
  planFiles: string[];

  @Column({ type: 'integer', name: 'todo', default: 0 })
  todo: number;

  @Column({ type: 'integer', name: 'doing', default: 0 })
  doing: number;

  @Column({ type: 'integer', name: 'done', default: 0 })
  done: number;

  @Column({ type: 'integer', name: 'unknown', default: 0 })
  unknown: number;

  @Column({ type: 'integer', name: 'total', default: 0 })
  total: number;

  @Column({ type: 'boolean', name: 'items_truncated', default: false })
  itemsTruncated: boolean;

  @Column({ type: 'boolean', name: 'read_truncated', default: false })
  readTruncated: boolean;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}
