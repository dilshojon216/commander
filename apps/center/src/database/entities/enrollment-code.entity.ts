import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Bir martalik enrollment kodi. Kod o'zi saqlanmaydi, faqat SHA-256 xeshi. */
@Entity('enrollment_codes')
export class EnrollmentCode {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'text', name: 'code_hash', unique: true })
  codeHash: string;

  @Column({ type: 'text', name: 'kind' })
  kind: 'agentd';

  @Column({ type: 'text', name: 'machine_name' })
  machineName: string;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'uuid', name: 'used_by_device_id', nullable: true })
  usedByDeviceId: string | null;
}
