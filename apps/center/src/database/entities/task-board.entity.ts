import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Doskada qo'lda surilgan ustun (overlay). Samarali ustun mantig'i: `apps/center/src/projects/task-board.ts`. */
@Entity('task_board')
export class TaskBoard {
  @PrimaryColumn({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @PrimaryColumn({ type: 'text', name: 'task_key' })
  taskKey: string;

  @Column({ type: 'text', name: 'board_column' })
  boardColumn: 'todo' | 'doing' | 'review' | 'done';

  @Column({ type: 'text', name: 'part', default: '' })
  part: string;

  @Column({ type: 'uuid', name: 'updated_by_device_id', nullable: true })
  updatedByDeviceId: string | null;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}
