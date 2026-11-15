import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Kalit/qiymat sozlamalar (hozir: `lockdown`). */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'text', name: 'key' })
  key: string;

  @Column({ type: 'jsonb', name: 'value' })
  value: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;
}
