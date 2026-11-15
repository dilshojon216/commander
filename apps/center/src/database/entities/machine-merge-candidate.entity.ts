import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Yangi verified mashina va legacy_unverified nomzod: qo'lda ko'rib chiqish uchun. Avto-merge yo'q. */
@Entity('machine_merge_candidates')
export class MachineMergeCandidate {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @Column({ type: 'uuid', name: 'candidate_machine_id' })
  candidateMachineId: string;

  @Column({ type: 'text', name: 'reason' })
  reason: string;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'resolved_at', nullable: true })
  resolvedAt: Date | null;
}
