import type { RuleScope } from '@commander/contracts';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Avto-ruxsat qoidasi (2.13). Mantiq: `approvals/approval-rules-logic.ts`. `expires_at` majburiy (<= 7 kun, DB CHECK).
 */
@Entity('approval_rules')
export class ApprovalRule {
  @PrimaryGeneratedColumn('identity', { name: 'id', type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string;

  @Column({ type: 'text', name: 'scope' })
  scope: RuleScope;

  @Column({ type: 'text', name: 'scope_ref' })
  scopeRef: string;

  @Column({ type: 'text', array: true, name: 'tools' })
  tools: string[];

  @Column({ type: 'text', array: true, name: 'path_globs', default: () => "'{}'" })
  pathGlobs: string[];

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'uuid', name: 'created_by_device_id' })
  createdByDeviceId: string;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', name: 'revoked_by_device_id', nullable: true })
  revokedByDeviceId: string | null;
}
