import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Append-only. `id`, `prev_hash`, `hash` DB trigger'i tomonidan to'ldiriladi
 * (INSERT'da ularni bermang). UPDATE/DELETE/TRUNCATE trigger bilan bloklangan.
 */
@Entity('audit_log')
export class AuditLog {
  @PrimaryColumn({ type: 'bigint', name: 'id', insert: false, update: false })
  id: string;

  @Column({ type: 'timestamptz', name: 'ts', default: () => 'clock_timestamp()' })
  ts: Date;

  @Column({ type: 'uuid', name: 'actor_device_id', nullable: true })
  actorDeviceId: string | null;

  @Column({ type: 'text', name: 'actor_kind' })
  actorKind: 'agentd' | 'web' | 'menubar' | 'mobile' | 'telegram' | 'system';

  @Column({ type: 'text', name: 'action' })
  action: string;

  @Column({ type: 'text', name: 'target', nullable: true })
  target: string | null;

  @Column({ type: 'jsonb', name: 'details', default: () => "'{}'" })
  details: Record<string, unknown>;

  @Column({ type: 'inet', name: 'ip', nullable: true })
  ip: string | null;

  @Column({ type: 'text', name: 'prev_hash', nullable: true, insert: false, update: false })
  prevHash: string | null;

  @Column({ type: 'text', name: 'hash', insert: false, update: false })
  hash: string;
}
