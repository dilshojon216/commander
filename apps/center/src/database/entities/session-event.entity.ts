import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { SessionStatus } from './session.entity.js';

const bigintToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
};

/**
 * Hypertable (ts bo'yicha). PK (id, ts): hypertable'da unique constraint vaqt
 * ustunini o'z ichiga olishi shart. `id` — identity ustun (v0 API `id`si).
 */
@Entity('session_events')
export class SessionEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint', name: 'id' })
  id: string;

  @PrimaryColumn({ type: 'timestamptz', name: 'ts', default: () => 'now()' })
  ts: Date;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'text', name: 'event' })
  event: string;

  @Column({ type: 'text', name: 'status' })
  status: SessionStatus;

  @Column({ type: 'text', name: 'message', nullable: true })
  message: string | null;

  @Column({ type: 'text', name: 'notification_type', nullable: true })
  notificationType: string | null;

  @Column({ type: 'bigint', name: 'client_ts', nullable: true, transformer: bigintToNumber })
  clientTs: number | null;

  /** agentd idempotentligi uchun; UNIQUE(machine_id, event_id, ts). */
  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId: string | null;
}
