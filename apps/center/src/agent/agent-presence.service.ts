import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import type { SessionRef } from '../realtime/realtime-bus.js';

export interface AgentPresenceInfo {
  hostname: string;
  os: string;
  agentdVersion: string;
  claudeVersion: string | null;
}

/**
 * Mashina online/offline holati va sessiyalarning `stale_since` belgisi.
 *
 * Representatsiya (migratsiya AgentChannel1731401000000):
 *  - `machines.online` + `connected_at`/`disconnected_at`;
 *  - mashina offline bo'lganda uning OCHIQ sessiyalarida (`ended_at IS NULL`) `stale_since = now()`.
 *    `status` o'zgarmaydi: "stale" holat emas, alohida o'q. Mashina qaytganda (yangi ulanish) hammasi
 *    NULL'ga qaytadi; haqiqiy holatni agentd keyingi hodisalar/reconciliation orqali tuzatadi.
 */
@Injectable()
export class AgentPresenceService {
  private readonly logger = new Logger(AgentPresenceService.name);
  private readonly lastTouch = new Map<string, number>();
  private readonly lastControl = new Map<string, string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bus: RealtimeBus,
  ) {}

  /** Markaz ishga tushganda: ulanishlar xotirada edi, demak hozir hech kim ulanmagan. */
  async resetAllOffline(): Promise<number> {
    const n = await this.dataSource.transaction(async (m) => {
      // CTE: TypeORM UPDATE ... RETURNING'ni [rows, count] juftligi qilib qaytaradi; SELECT esa oddiy qatorlar beradi.
      const rows: Array<{ id: string }> = await m.query(
        `WITH upd AS (
           UPDATE machines SET online = false, disconnected_at = COALESCE(disconnected_at, now()) WHERE online RETURNING id
         ) SELECT id FROM upd`,
      );
      const refs = rows.length > 0 ? await this.markSessionsStale(m, rows.map((r) => r.id)) : [];
      return { ids: rows.map((r) => r.id), refs };
    });
    this.publish(n.ids, n.refs);
    return n.ids.length;
  }

  async markOnline(machineId: string, info: AgentPresenceInfo): Promise<void> {
    const refs = await this.dataSource.transaction(async (m) => {
      await m.query(
        `UPDATE machines
            SET online = true, connected_at = now(), last_seen_at = now(),
                hostname = $2, os = $3, agentd_version = $4, claude_version = $5
          WHERE id = $1`,
        [machineId, info.hostname, info.os, info.agentdVersion, info.claudeVersion],
      );
      return this.sessionRefs(
        m,
        `WITH upd AS (UPDATE sessions SET stale_since = NULL WHERE machine_id = $1 AND stale_since IS NOT NULL RETURNING machine_id, claude_session_id)
         SELECT machine_id, claude_session_id FROM upd`,
        [machineId],
      );
    });
    this.lastTouch.set(machineId, Date.now());
    this.publish([machineId], refs);
  }

  async markOffline(machineId: string): Promise<void> {
    const refs = await this.dataSource.transaction(async (m) => {
      await m.query(`UPDATE machines SET online = false, disconnected_at = now() WHERE id = $1`, [machineId]);
      return this.markSessionsStale(m, [machineId]);
    });
    this.lastTouch.delete(machineId);
    this.lastControl.delete(machineId);
    this.publish([machineId], refs);
  }

  /** `machines.last_seen_at` ni yangilaydi, lekin 30 s dan tez emas (har xabarda DB'ga yozmaslik uchun). */
  async touch(machineId: string, now: number = Date.now()): Promise<void> {
    const last = this.lastTouch.get(machineId) ?? 0;
    if (now - last < 30_000) return;
    this.lastTouch.set(machineId, now);
    try {
      await this.dataSource.query(`UPDATE machines SET last_seen_at = now() WHERE id = $1`, [machineId]);
    } catch (err) {
      this.logger.warn(`machines.last_seen_at update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Heartbeat'dagi tirik sessiyalarning `last_seen_at` ini yangilaydi (tugamaganlar). `active` berilsa va `kind`
   * ma'lum bo'lsa, `sessions.kind` ham yangilanadi (`bg` = boshqariladigan; UI `controllable` shundan).
   * Kind o'zgargan sessiyalar klientlarga e'lon qilinadi.
   */
  async touchSessions(machineId: string, claudeSessionIds: string[], active?: Array<{ claudeSessionId: string; kind?: string | undefined }>): Promise<void> {
    if (claudeSessionIds.length === 0) return;
    await this.dataSource.query(
      `UPDATE sessions SET last_seen_at = now(), stale_since = NULL
        WHERE machine_id = $1 AND claude_session_id = ANY($2::text[]) AND ended_at IS NULL`,
      [machineId, claudeSessionIds],
    );
    // `claude agents --json` jarayon tirik deydi, lekin bizda 'ended' (masalan stop+resume'dan keyin yangi SessionStart
    // yetib kelmagan): sessiyani tiklaymiz. 20 s himoya — SessionEnd'dan oldin olingan eski heartbeat qayta ochib yubormasin.
    const revived: Array<{ machine_id: string; claude_session_id: string }> = await this.dataSource.query(
      `UPDATE sessions SET status = 'idle', status_since = now(), ended_at = NULL, end_reason = NULL,
              last_seen_at = now(), stale_since = NULL
        WHERE machine_id = $1 AND claude_session_id = ANY($2::text[]) AND ended_at IS NOT NULL
          AND ended_at < now() - interval '20 seconds'
        RETURNING machine_id, claude_session_id`,
      [machineId, claudeSessionIds],
    );
    if (revived.length > 0) this.bus.publish({ type: 'sessions.changed', refs: revived.map((r) => ({ machineId: r.machine_id, claudeSessionId: r.claude_session_id })) });
    const kinds = (active ?? []).filter((a): a is { claudeSessionId: string; kind: string } => a.kind !== undefined);
    if (kinds.length === 0) return;
    const rows: Array<{ machine_id: string; claude_session_id: string }> = await this.dataSource.query(
      `WITH upd AS (
         UPDATE sessions s SET kind = k.kind
           FROM unnest($2::text[], $3::text[]) AS k(id, kind)
          WHERE s.machine_id = $1 AND s.claude_session_id = k.id AND s.ended_at IS NULL AND s.kind <> k.kind
         RETURNING s.machine_id, s.claude_session_id
       ) SELECT machine_id, claude_session_id FROM upd`,
      [machineId, kinds.map((k) => k.claudeSessionId), kinds.map((k) => k.kind)],
    );
    if (rows.length > 0) this.bus.publish({ type: 'sessions.changed', refs: rows.map((r) => ({ machineId: r.machine_id, claudeSessionId: r.claude_session_id })) });
  }

  /**
   * agentd e'lon qilgan lokal siyosat holati (`machines.control`). O'zgarmagan bo'lsa DB'ga yozilmaydi; o'zgarsa mashina va
   * uning ochiq sessiyalari klientlarga e'lon qilinadi (`controllable` o'zgaradi).
   */
  async updateControl(machineId: string, control: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(control);
    if (this.lastControl.get(machineId) === json) return;
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `WITH upd AS (
         UPDATE machines SET control = $2::jsonb, control_reported_at = now()
          WHERE id = $1 AND control IS DISTINCT FROM $2::jsonb RETURNING id
       ) SELECT id FROM upd`,
      [machineId, json],
    );
    this.lastControl.set(machineId, json);
    if (rows.length === 0) return;
    const sessions: Array<{ claude_session_id: string }> = await this.dataSource.query(`SELECT claude_session_id FROM sessions WHERE machine_id = $1 AND ended_at IS NULL`, [machineId]);
    this.bus.publish({ type: 'machine.changed', machineId });
    if (sessions.length > 0) this.bus.publish({ type: 'sessions.changed', refs: sessions.map((s) => ({ machineId, claudeSessionId: s.claude_session_id })) });
  }

  private async markSessionsStale(m: DataSource['manager'], machineIds: string[]): Promise<SessionRef[]> {
    return this.sessionRefs(
      m,
      `WITH upd AS (
         UPDATE sessions SET stale_since = now()
          WHERE machine_id = ANY($1::uuid[]) AND ended_at IS NULL AND stale_since IS NULL
         RETURNING machine_id, claude_session_id
       ) SELECT machine_id, claude_session_id FROM upd`,
      [machineIds],
    );
  }

  private async sessionRefs(m: DataSource['manager'], sql: string, params: unknown[]): Promise<SessionRef[]> {
    const rows: Array<{ machine_id: string; claude_session_id: string }> = await m.query(sql, params);
    return rows.map((r) => ({ machineId: r.machine_id, claudeSessionId: r.claude_session_id }));
  }

  /** COMMIT'dan keyin: mashina va stale holati o'zgargan sessiyalar haqida klientlarga e'lon. */
  private publish(machineIds: string[], refs: SessionRef[]): void {
    for (const id of machineIds) this.bus.publish({ type: 'machine.changed', machineId: id });
    if (refs.length > 0) this.bus.publish({ type: 'sessions.changed', refs });
  }
}
