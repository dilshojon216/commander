import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** DB CHECK ro'yxati (eski `session.interrupt` va `agent.reconfigure` ham saqlanadi; REST faqat `@commander/contracts` COMMAND_TYPES). */
export const COMMAND_TYPES = [
  'session.start',
  'session.prompt',
  'session.interrupt',
  'session.stop',
  'session.set_mode',
  'session.remote_control',
  'agent.reconfigure',
  'project.refresh',
  'project.read_md',
  'project.append_tasks',
  'project.summarize',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATUSES = [
  'awaiting_confirmation',
  'pending',
  'sent',
  'acked',
  'running',
  'done',
  'failed',
  'expired',
  'rejected',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** Har bir masofaviy amal shu jadvaldan o'tadi (CLAUDE.md #1). Mantiq Faza 1'da. */
@Entity('commands')
export class Command {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'text', name: 'type' })
  type: CommandType;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'uuid', name: 'session_id', nullable: true })
  sessionId: string | null;

  /** Loyiha buyruqlari (2.15) uchun. */
  @Column({ type: 'uuid', name: 'project_id', nullable: true })
  projectId: string | null;

  @Column({ type: 'jsonb', name: 'payload', default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'text', name: 'status', default: 'pending' })
  status: CommandStatus;

  @Column({ type: 'uuid', name: 'requested_by_device_id' })
  requestedByDeviceId: string;

  @Column({ type: 'uuid', name: 'confirmed_by_device_id', nullable: true })
  confirmedByDeviceId: string | null;

  /** Replay'ga qarshi: UNIQUE(requested_by_device_id, nonce). */
  @Column({ type: 'text', name: 'nonce' })
  nonce: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'jsonb', name: 'result', nullable: true })
  result: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'confirmed_at', nullable: true })
  confirmedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'sent_at', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', name: 'acked_at', nullable: true })
  ackedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt: Date | null;

  /** Tana xeshi (idempotentlik: bir xil kalit + boshqa tana = 409). */
  @Column({ type: 'text', name: 'request_hash', nullable: true })
  requestHash: string | null;

  /** Agentga yuborilgan bir martalik nonce (imzo ichida). */
  @Column({ type: 'text', name: 'dispatch_nonce', nullable: true })
  dispatchNonce: string | null;

  @Column({ type: 'text', name: 'error_code', nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', name: 'error_message', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'boolean', name: 'step_up_required', default: false })
  stepUpRequired: boolean;
}
