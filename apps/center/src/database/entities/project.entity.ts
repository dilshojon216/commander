import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'text', name: 'path' })
  path: string;

  @Column({ type: 'text', name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'git_remote', nullable: true })
  gitRemote: string | null;

  /** Normallashtirilgan remote URL (github.com/org/repo); mashinalar bo'ylab jamlash uchun. */
  @Column({ type: 'text', name: 'repo_key', nullable: true })
  repoKey: string | null;

  /** 'git' (git toplevel) yoki 'dir' (git bo'lmagan cwd). */
  @Column({ type: 'text', name: 'kind', default: 'git' })
  kind: 'git' | 'dir';

  @Column({ type: 'timestamptz', name: 'last_snapshot_at', nullable: true })
  lastSnapshotAt: Date | null;

  /** 6.16: arxivlangan vaqt; NULL = faol. Arxivlangan loyiha ro'yxatlardan yashiriladi (ma'lumot o'chmaydi). */
  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archivedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;
}
