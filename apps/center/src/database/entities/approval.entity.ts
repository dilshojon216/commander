import { APPROVAL_STATUSES } from '@commander/contracts';
import type { ApprovalStatus } from '@commander/contracts';
import { Column, Entity, PrimaryColumn } from 'typeorm';

export { APPROVAL_STATUSES };
export type { ApprovalStatus };

/**
 * Remote permission so'rovi (1.7). `id` = agentd `approvalId`. Holat o'tishlari: `approvals/approval-state.ts`.
 * `tool_input_redacted` redakt qilingan va kesilgan matn; xom kiritma hech qayerda saqlanmaydi.
 */
@Entity('approvals')
export class Approval {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'text', name: 'claude_session_id' })
  claudeSessionId: string;

  @Column({ type: 'text', name: 'cwd' })
  cwd: string;

  @Column({ type: 'text', name: 'tool_name' })
  toolName: string;

  @Column({ type: 'text', name: 'tool_input_redacted' })
  toolInputRedacted: string;

  @Column({ type: 'text', name: 'tool_input_full_hash' })
  toolInputFullHash: string;

  @Column({ type: 'text', name: 'status', default: 'pending' })
  status: ApprovalStatus;

  @Column({ type: 'text', name: 'decision_message', nullable: true })
  decisionMessage: string | null;

  @Column({ type: 'uuid', name: 'decided_by_device_id', nullable: true })
  decidedByDeviceId: string | null;

  @Column({ type: 'timestamptz', name: 'decided_at', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', name: 'requested_at', default: () => 'now()' })
  requestedAt: Date;

  @Column({ type: 'timestamptz', name: 'deadline' })
  deadline: Date;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'text', name: 'prev_session_status', nullable: true })
  prevSessionStatus: string | null;

  /** 'tool' | 'plan' (2.14). */
  @Column({ type: 'text', name: 'kind', default: 'tool' })
  kind: 'tool' | 'plan' | 'question';

  /** Redakt qilingan reja matni (<= 16384); 30 kundan keyin NULL. */
  @Column({ type: 'text', name: 'plan_text', nullable: true })
  planText: string | null;

  /** AskUserQuestion (6.13): redakt qilingan savollar (jsonb). 30 kundan keyin NULL. */
  @Column({ type: 'jsonb', name: 'questions', nullable: true })
  questions: unknown[] | null;

  /** Berilgan javoblar (variant indekslari + redakt qilingan erkin matn). */
  @Column({ type: 'jsonb', name: 'answers', nullable: true })
  answers: unknown[] | null;

  /** Avto-ruxsat qoidasi (2.13): hal qilgan qoida id'si (bigint, matn). */
  @Column({ type: 'bigint', name: 'auto_rule_id', nullable: true })
  autoRuleId: string | null;
}
