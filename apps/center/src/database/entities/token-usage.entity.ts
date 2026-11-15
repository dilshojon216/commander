import { Column, Entity, PrimaryColumn } from 'typeorm';

const bigintToNumber = {
  to: (value: number): number => value,
  from: (value: string): number => Number(value),
};

export const TOKEN_USAGE_SOURCES = ['otel', 'transcript'] as const;
export type TokenUsageSource = (typeof TOKEN_USAGE_SOURCES)[number];

/**
 * Hypertable. Har api_request uchun bitta qator. PII (email/account/organization)
 * ustunlari YO'Q — agentd ularni yuborishdan oldin olib tashlaydi (PLAN §13 S1).
 */
@Entity('token_usage')
export class TokenUsage {
  @PrimaryColumn({ type: 'uuid', name: 'machine_id' })
  machineId: string;

  @PrimaryColumn({ type: 'text', name: 'request_id' })
  requestId: string;

  @PrimaryColumn({ type: 'timestamptz', name: 'ts' })
  ts: Date;

  /** Claude session id (OTel `session.id`); FK yo'q. */
  @Column({ type: 'text', name: 'session_id', nullable: true })
  sessionId: string | null;

  /** Insert vaqtida denormalizatsiya qilinadi (upsert_project); NULL = "noma'lum". */
  @Column({ type: 'uuid', name: 'project_id', nullable: true })
  projectId: string | null;

  @Column({ type: 'text', name: 'prompt_id', nullable: true })
  promptId: string | null;

  @Column({ type: 'text', name: 'model' })
  model: string;

  @Column({ type: 'bigint', name: 'input_tokens', default: 0, transformer: bigintToNumber })
  inputTokens: number;

  @Column({ type: 'bigint', name: 'output_tokens', default: 0, transformer: bigintToNumber })
  outputTokens: number;

  @Column({ type: 'bigint', name: 'cache_read_tokens', default: 0, transformer: bigintToNumber })
  cacheReadTokens: number;

  @Column({ type: 'bigint', name: 'cache_creation_tokens', default: 0, transformer: bigintToNumber })
  cacheCreationTokens: number;

  /** numeric(14,6), satr sifatida (aniqlik yo'qolmasin). */
  @Column({ type: 'numeric', precision: 14, scale: 6, name: 'cost_usd', nullable: true })
  costUsd: string | null;

  @Column({ type: 'text', name: 'source' })
  source: TokenUsageSource;

  @Column({ type: 'timestamptz', name: 'received_at', default: () => 'now()' })
  receivedAt: Date;
}
