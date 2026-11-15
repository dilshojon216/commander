import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Bir martalik klient pairing kodi. Kod o'zi saqlanmaydi, faqat SHA-256 xeshi. */
@Entity('client_pairing_codes')
export class ClientPairingCode {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'text', name: 'code_hash', unique: true })
  codeHash: string;

  @Column({ type: 'text', name: 'kind' })
  kind: 'menubar' | 'mobile';

  @Column({ type: 'text', name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'scopes', array: true })
  scopes: string[];

  @Column({ type: 'integer', name: 'token_days', default: 90 })
  tokenDays: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'uuid', name: 'used_by_device_id', nullable: true })
  usedByDeviceId: string | null;
}
