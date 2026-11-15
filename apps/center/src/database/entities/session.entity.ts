import { SESSION_STATUSES } from '@commander/contracts';
import type { SessionStatus } from '@commander/contracts';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Machine } from './machine.entity.js';

// Status enum yagona manbasi — @commander/contracts; shu yerdan re-export qilinadi.
export { SESSION_STATUSES };
export type { SessionStatus };

export const SESSION_KINDS = ['interactive', 'bg', 'tmux'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** v2: mashinaga bog'langan sessiya. Claude session_id = `claude_session_id`. */
@Entity('sessions')
@Unique('uq_sessions_machine_claude_session', ['machineId', 'claudeSessionId'])
export class Session {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @ManyToOne(() => Machine, { nullable: false })
  @JoinColumn({ name: 'machine_id' })
  machine?: Machine;

  @Column({ type: 'text', name: 'claude_session_id' })
  claudeSessionId: string;

  @Column({ type: 'uuid', name: 'project_id', nullable: true })
  projectId: string | null;

  @Column({ type: 'text', name: 'cwd' })
  cwd: string;

  /** Sessiya BOSHLANGAN cwd (birinchi hodisa; bir marta yoziladi). */
  @Column({ type: 'text', name: 'start_cwd', nullable: true })
  startCwd: string | null;

  /** Loyiha qismi (6.15): start_cwd prefiksi bo'lgan eng uzun qism; '' = ildiz; NULL = hali aniqlanmagan. Bir marta yoziladi. */
  @Column({ type: 'text', name: 'part', nullable: true })
  part: string | null;

  /** v0 API ko'rsatadigan nom (cwd'ning oxirgi segmenti). */
  @Column({ type: 'text', name: 'project' })
  project: string;

  @Column({ type: 'text', name: 'name', nullable: true })
  name: string | null;

  @Column({ type: 'text', name: 'kind', default: 'interactive' })
  kind: SessionKind;

  @Column({ type: 'text', name: 'status' })
  status: SessionStatus;

  @Column({ type: 'text', name: 'message', nullable: true })
  message: string | null;

  @Column({ type: 'text', name: 'notification_type', nullable: true })
  notificationType: string | null;

  @Column({ type: 'jsonb', name: 'controllable', default: () => "'{}'" })
  controllable: Record<string, unknown>;

  @Column({ type: 'text', name: 'started_by', default: 'local' })
  startedBy: string;

  @Column({ type: 'text', name: 'model', nullable: true })
  model: string | null;

  /** Hook'dagi oxirgi `permission_mode` (NULL = noma'lum). */
  @Column({ type: 'text', name: 'permission_mode', nullable: true })
  permissionMode: string | null;

  @Column({ type: 'timestamptz', name: 'started_at' })
  startedAt: Date;

  @Column({ type: 'timestamptz', name: 'status_since' })
  statusSince: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', name: 'ended_at', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'text', name: 'end_reason', nullable: true })
  endReason: string | null;

  /**
   * Mashina offline bo'lgan paytdan beri (NULL = stale emas). `status` o'zgarmaydi: "stale" alohida
   * o'q, holat emas. Mashina qaytganda yoki yangi hodisa kelganda NULL'ga qaytadi.
   */
  @Column({ type: 'timestamptz', name: 'stale_since', nullable: true })
  staleSince: Date | null;

  /** Remote Control holati (3.10): `{enabled, name, since, url?}`; NULL = noma'lum. */
  @Column({ type: 'jsonb', name: 'remote_control', nullable: true })
  remoteControl?: Record<string, unknown> | null;

  /** `SessionStart`dagi git HEAD sha (3.5: sessiya diff'i bazasi); NULL = noma'lum. */
  @Column({ type: 'text', name: 'start_head_sha', nullable: true })
  startHeadSha?: string | null;

  /** Oxirgi hodisadagi `transcriptPath` (mashina-lokal yo'l). */
  @Column({ type: 'text', name: 'transcript_path', nullable: true })
  transcriptPath: string | null;
}
