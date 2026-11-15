import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const MACHINE_IDENTITY_STATUSES = ['verified', 'legacy_unverified'] as const;
export type MachineIdentityStatus = (typeof MACHINE_IDENTITY_STATUSES)[number];

/**
 * Fizik mashina. Identity hostname emas: `hardware_id` va/yoki enroll qilingan agentd
 * qurilmasi. `legacy_host` — v0 `host` satri (faqat v0 API uchun kalit).
 */
@Entity('machines')
@Index('idx_machines_merged_into', ['mergedIntoId'], { where: '"merged_into_id" IS NOT NULL' })
export class Machine {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'text', name: 'slug', unique: true })
  slug: string;

  @Column({ type: 'text', name: 'display_name', nullable: true })
  displayName: string | null;

  @Column({ type: 'text', name: 'hostname', nullable: true })
  hostname: string | null;

  @Column({ type: 'text', name: 'legacy_host', nullable: true, unique: true })
  legacyHost: string | null;

  @Column({ type: 'text', name: 'hardware_id', nullable: true, unique: true })
  hardwareId: string | null;

  @Column({ type: 'text', name: 'os', nullable: true })
  os: string | null;

  @Column({ type: 'text', name: 'tailnet_name', nullable: true })
  tailnetName: string | null;

  @Column({ type: 'text', name: 'identity_status', default: 'legacy_unverified' })
  identityStatus: MachineIdentityStatus;

  @Column({ type: 'text', name: 'status', default: 'active' })
  status: 'active' | 'retired';

  @Column({ type: 'uuid', name: 'merged_into_id', nullable: true })
  mergedIntoId: string | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at', nullable: true })
  lastSeenAt: Date | null;

  /** agentd WS ulanishi hozir ochiqmi (heartbeat 60 s timeout; markaz restartida hammasi false). */
  @Column({ type: 'boolean', name: 'online', default: false })
  online: boolean;

  @Column({ type: 'timestamptz', name: 'connected_at', nullable: true })
  connectedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'disconnected_at', nullable: true })
  disconnectedAt: Date | null;

  @Column({ type: 'text', name: 'agentd_version', nullable: true })
  agentdVersion: string | null;

  @Column({ type: 'text', name: 'claude_version', nullable: true })
  claudeVersion: string | null;

  /** agentd e'lon qilgan lokal siyosat holati (`AgentControlState`, yo'llarsiz); markaz o'zgartirmaydi. */
  @Column({ type: 'jsonb', name: 'control', nullable: true })
  control: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', name: 'control_reported_at', nullable: true })
  controlReportedAt: Date | null;

  /** N2.14: arxivlangan vaqt (NULL = faol). Arxiv = standart ro'yxatdan yashirish; ma'lumot o'chmaydi. */
  @Column({ type: 'timestamptz', name: 'archived_at', nullable: true })
  archivedAt: Date | null;
}
