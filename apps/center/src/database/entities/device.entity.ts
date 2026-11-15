import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const DEVICE_KINDS = ['agentd', 'web', 'menubar', 'mobile', 'telegram'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Enroll qilingan agentd yoki klient (token) qurilmasi. Mantiq: src/identity. */
@Entity('devices')
export class Device {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ type: 'uuid', name: 'machine_id', nullable: true })
  machineId: string | null;

  @Column({ type: 'text', name: 'kind' })
  kind: DeviceKind;

  @Column({ type: 'text', name: 'name', nullable: true })
  name: string | null;

  /** Ed25519 public key, xom 32 bayt (agentd). */
  @Column({ type: 'bytea', name: 'public_key', nullable: true, unique: true })
  publicKey: Buffer | null;

  /** Klient tokenining SHA-256 xeshi (token o'zi saqlanmaydi). */
  @Column({ type: 'text', name: 'token_hash', nullable: true, unique: true })
  tokenHash: string | null;

  /** Tashqi identifikator (masalan Telegram chat_id). */
  @Column({ type: 'text', name: 'external_id', nullable: true })
  externalId: string | null;

  @Column({ type: 'text', name: 'scopes', array: true, default: () => "'{}'" })
  scopes: string[];

  /** Pairing paytida klient bildirgan platforma (macos | ios | android | ...). */
  @Column({ type: 'text', name: 'platform', nullable: true })
  platform: string | null;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'last_used_at', nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt: Date | null;

  /** Markaz kalitni aylantirishni talab qilmoqda (5.1); `key.rotate` muvaffaqiyatli bo'lsa false. */
  @Column({ type: 'boolean', name: 'rotation_required', default: false })
  rotationRequired: boolean;

  @Column({ type: 'timestamptz', name: 'key_rotated_at', nullable: true })
  keyRotatedAt: Date | null;

  /** Klient tokeni muddati (NULL = muddatsiz). */
  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt: Date | null;
}
