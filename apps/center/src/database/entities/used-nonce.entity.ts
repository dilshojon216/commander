import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Imzolangan so'rovlarda ishlatilgan nonce'lar (replay himoyasi), `expires_at`dan keyin tozalanadi. */
@Entity('used_nonces')
export class UsedNonce {
  @PrimaryColumn({ type: 'uuid', name: 'device_id' })
  deviceId: string;

  @PrimaryColumn({ type: 'text', name: 'nonce' })
  nonce: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt: Date;
}
