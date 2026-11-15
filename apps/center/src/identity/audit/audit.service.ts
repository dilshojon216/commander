import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { AuditEntry, AuditVerifyResponse, ListAuditQuery } from '@commander/contracts';
import { sanitizeAuditDetails } from './redact.js';

export type AuditActorKind = AuditEntry['actor_kind'];

export interface AuditRecord {
  actorDeviceId?: string | null;
  actorKind: AuditActorKind;
  action: string;
  target?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

interface AuditRow {
  id: string;
  ts: Date;
  actor_device_id: string | null;
  actor_kind: AuditActorKind;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  prev_hash: string | null;
  hash: string;
}

/**
 * audit_log'ga yagona yozish nuqtasi. `id`, `prev_hash`, `hash` DB trigger'i (0.5,
 * `audit_log_before_insert`) tomonidan to'ldiriladi: ilova zanjirni HISOBLAMAYDI.
 * Tranzaksiya ichida yozish uchun `manager` bering (amal va audit atomik bo'ladi).
 */
@Injectable()
export class AuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async record(rec: AuditRecord, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource.manager;
    await runner.query(
      `INSERT INTO audit_log (actor_device_id, actor_kind, action, target, details, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::inet)`,
      [
        rec.actorDeviceId ?? null,
        rec.actorKind,
        rec.action,
        rec.target ?? null,
        JSON.stringify(sanitizeAuditDetails(rec.details ?? {})),
        rec.ip ?? null,
      ],
    );
  }

  async list(query: ListAuditQuery): Promise<{ items: AuditEntry[]; next_before: string | null }> {
    const rows: AuditRow[] = await this.dataSource.query(
      `SELECT id::text AS id, ts, actor_device_id, actor_kind, action, target, details,
              host(ip) AS ip, prev_hash, hash
         FROM audit_log
        WHERE ($1::bigint IS NULL OR audit_log.id < $1::bigint)
          AND ($2::text IS NULL OR action = $2)
        ORDER BY audit_log.id DESC
        LIMIT $3`,
      [query.before ?? null, query.action ?? null, query.limit + 1],
    );
    const page = rows.slice(0, query.limit);
    const items = page.map((r) => ({ ...r, ts: r.ts.toISOString() }));
    return { items, next_before: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null };
  }

  /** Zanjirni boshidan yuradi (DB funksiyasi `audit_log_verify`) va birinchi buzilgan id'ni qaytaradi. */
  async verify(): Promise<AuditVerifyResponse> {
    const [verdict]: Array<{ v: string | null }> = await this.dataSource.query(`SELECT audit_log_verify()::text AS v`);
    const [count]: Array<{ n: string }> = await this.dataSource.query(`SELECT count(*)::text AS n FROM audit_log`);
    const broken = verdict?.v ?? null;
    return { ok: broken === null, first_broken_id: broken, checked_rows: count?.n ?? '0' };
  }
}
