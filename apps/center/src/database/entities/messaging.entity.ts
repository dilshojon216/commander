import type { MessageKind, MessageStatus, Rule } from '@commander/contracts';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Guruh sozlamalari (task 2.10). Sukutda hammasi O'CHIQ. */
@Entity('messaging_groups')
export class MessagingGroup {
  @PrimaryColumn({ type: 'text', name: 'group_key' })
  groupKey: string;

  @Column({ type: 'boolean', name: 'enabled', default: false })
  enabled: boolean;

  @Column({ type: 'boolean', name: 'auto_wake', default: false })
  autoWake: boolean;

  @Column({ type: 'boolean', name: 'telegram_questions', default: false })
  telegramQuestions: boolean;

  @Column({ type: 'text', name: 'context', default: '' })
  context: string;

  @Column({ type: 'timestamptz', name: 'context_updated_at', nullable: true })
  contextUpdatedAt: Date | null;

  @Column({ type: 'jsonb', name: 'rules', default: () => "'[]'" })
  rules: Rule[];

  @Column({ type: 'uuid', name: 'updated_by_device_id', nullable: true })
  updatedByDeviceId: string | null;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}

/** Repo (`base_key`) -> workspace. Bir repo bitta workspace'da. */
@Entity('project_links')
export class ProjectLink {
  @PrimaryColumn({ type: 'text', name: 'base_key' })
  baseKey: string;

  @Column({ type: 'text', name: 'workspace' })
  workspace: string;

  @Column({ type: 'uuid', name: 'created_by_device_id', nullable: true })
  createdByDeviceId: string | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;
}

@Entity('session_roles')
export class SessionRole {
  @PrimaryColumn({ type: 'uuid', name: 'session_id' })
  sessionId: string;

  @Column({ type: 'text', name: 'role' })
  role: string;

  @Column({ type: 'text', name: 'source' })
  source: 'owner' | 'session';

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}

/** Pochta qutisi: har qabul qiluvchi uchun alohida qator. */
@Entity('session_messages')
export class SessionMessage {
  @PrimaryColumn({ type: 'uuid', name: 'id', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'uuid', name: 'batch_id' })
  batchId: string;

  @Column({ type: 'text', name: 'group_key' })
  groupKey: string;

  @Column({ type: 'uuid', name: 'from_session_id', nullable: true })
  fromSessionId: string | null;

  @Column({ type: 'text', name: 'from_role' })
  fromRole: string;

  @Column({ type: 'text', name: 'from_label', default: '' })
  fromLabel: string;

  @Column({ type: 'uuid', name: 'to_session_id' })
  toSessionId: string;

  @Column({ type: 'text', name: 'to_role', nullable: true })
  toRole: string | null;

  @Column({ type: 'text', name: 'to_target' })
  toTarget: string;

  @Column({ type: 'text', name: 'kind' })
  kind: MessageKind;

  @Column({ type: 'text', name: 'subject' })
  subject: string;

  @Column({ type: 'text', name: 'body' })
  body: string;

  @Column({ type: 'uuid', name: 'reply_to', nullable: true })
  replyTo: string | null;

  @Column({ type: 'text', name: 'status', default: 'pending' })
  status: MessageStatus;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', name: 'read_at', nullable: true })
  readAt: Date | null;
}
