import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Faqat `hash` o'zgarganda yoziladi: UNIQUE(project_id, hash). */
@Entity('project_snapshots')
export class ProjectSnapshot {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @Column({ type: 'timestamptz', name: 'taken_at', default: () => 'now()' })
  takenAt: Date;

  @Column({ type: 'text', name: 'hash' })
  hash: string;

  @Column({ type: 'text', name: 'branch', nullable: true })
  branch: string | null;

  @Column({ type: 'integer', name: 'ahead', nullable: true })
  ahead: number | null;

  @Column({ type: 'integer', name: 'behind', nullable: true })
  behind: number | null;

  @Column({ type: 'integer', name: 'dirty_count', nullable: true })
  dirtyCount: number | null;

  @Column({ type: 'jsonb', name: 'commits', default: () => "'[]'" })
  commits: unknown[];

  @Column({ type: 'text', name: 'todos_md', nullable: true })
  todosMd: string | null;

  @Column({ type: 'text', name: 'changelog_md', nullable: true })
  changelogMd: string | null;

  @Column({ type: 'text', name: 'head_sha', nullable: true })
  headSha: string | null;

  /** TASKS.md matni (faqat oxirgi ~3 snapshot'da; eskilarida NULL). Vazifalar `project_tasks`da. */
  @Column({ type: 'text', name: 'tasks_md', nullable: true })
  tasksMd: string | null;

  @Column({ type: 'text', name: 'tasks_path', nullable: true })
  tasksPath: string | null;

  /** Loyihadagi *.md fayllar ro'yxati (agentd; <= 200). */
  @Column({ type: 'jsonb', name: 'md_files', nullable: true })
  mdFiles: string[] | null;

  /** TASKS.md xom baytlari sha256'i (append optimistik konkurentligi). */
  @Column({ type: 'text', name: 'tasks_hash', nullable: true })
  tasksHash: string | null;
}
