import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DECISION_LIMITS, RecordDecisionCallSchema, formatDecisionsContext } from '@commander/contracts';
import type { CreateDecisionBody, DecisionDto, DecisionSource, DecisionStatus, PatchDecisionBody } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { MessagingError } from '../messaging/messaging.service.js';
import { normTitle } from './summary-logic.js';

interface DecisionRow {
  id: string;
  base_key: string;
  project_id: string | null;
  title: string;
  decision: string;
  reason: string;
  alternatives: string[];
  status: DecisionStatus;
  source: DecisionSource;
  source_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toDecisionDto(r: DecisionRow): DecisionDto {
  return {
    id: r.id,
    baseKey: r.base_key,
    projectId: r.project_id,
    title: r.title,
    decision: r.decision,
    reason: r.reason,
    alternatives: r.alternatives,
    status: r.status,
    source: r.source,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface DecisionActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip: string | null;
}

const BASE_KEY_SQL = `COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text)`;

/**
 * Loyiha qarorlari jurnali (6.3). `base_key` = repo_key (yoki `project:<uuid>`): bir repo barcha mashinalarda bitta jurnal.
 * Sessiya MCP vositasi bilan yozadi (rate limit, redakt, audit), egasi REST bilan tahrirlaydi, xulosa "taklif" qiladi.
 * Yangi sessiyaning birinchi promptida oxirgi faol qarorlar kontekstga tushadi (`injectionFor`, fail-safe).
 */
@Injectable()
export class DecisionsService {
  private readonly logger = new Logger(DecisionsService.name);
  private readonly limiter = new FixedWindowLimiter(DECISION_LIMITS.recordLimit, DECISION_LIMITS.recordWindowMs);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private async baseKeyOf(projectId: string): Promise<{ baseKey: string; projectId: string }> {
    const rows: Array<{ base_key: string }> = await this.dataSource.query(`SELECT ${BASE_KEY_SQL} AS base_key FROM projects p WHERE p.id = $1`, [projectId]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
    return { baseKey: rows[0].base_key, projectId };
  }

  async list(projectId: string, status?: DecisionStatus): Promise<DecisionDto[]> {
    const { baseKey } = await this.baseKeyOf(projectId);
    const rows: DecisionRow[] = await this.dataSource.query(
      `SELECT * FROM project_decisions WHERE base_key = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, id LIMIT 500`,
      [baseKey, status ?? null],
    );
    return rows.map(toDecisionDto);
  }

  async create(projectId: string, body: CreateDecisionBody, actor: DecisionActor): Promise<DecisionDto> {
    const { baseKey } = await this.baseKeyOf(projectId);
    return this.dataSource.transaction(async (m) => {
      const rows: DecisionRow[] = await m.query(
        `INSERT INTO project_decisions (base_key, project_id, title, decision, reason, alternatives, status, source)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', 'owner') RETURNING *`,
        [baseKey, projectId, redactAndCap(body.title, 120), redactAndCap(body.decision, 1000), redactAndCap(body.reason, 1000), JSON.stringify(body.alternatives.map((a) => redactAndCap(a, 200)))],
      );
      const r = rows[0] as DecisionRow;
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'decision.created', target: r.id, ip: actor.ip, details: { baseKey, source: 'owner', titleChars: r.title.length } }, m);
      return toDecisionDto(r);
    });
  }

  async patch(id: string, body: PatchDecisionBody, actor: DecisionActor): Promise<DecisionDto> {
    return this.dataSource.transaction(async (m) => {
      const cur: DecisionRow[] = await m.query(`SELECT * FROM project_decisions WHERE id = $1 FOR UPDATE`, [id]);
      const c = cur[0];
      if (!c) throw new NotFoundException({ error: 'not_found', message: 'Decision not found' });
      const next = {
        title: body.title !== undefined ? redactAndCap(body.title, 120) : c.title,
        decision: body.decision !== undefined ? redactAndCap(body.decision, 1000) : c.decision,
        reason: body.reason !== undefined ? redactAndCap(body.reason, 1000) : c.reason,
        alternatives: body.alternatives !== undefined ? body.alternatives.map((a) => redactAndCap(a, 200)) : c.alternatives,
        status: body.status ?? c.status,
      };
      await m.query(`UPDATE project_decisions SET title = $2, decision = $3, reason = $4, alternatives = $5::jsonb, status = $6, updated_at = now() WHERE id = $1`, [
        id,
        next.title,
        next.decision,
        next.reason,
        JSON.stringify(next.alternatives),
        next.status,
      ]);
      const rows: DecisionRow[] = await m.query(`SELECT * FROM project_decisions WHERE id = $1`, [id]);
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'decision.updated', target: id, ip: actor.ip, details: { from: c.status, to: next.status, fields: Object.keys(body) } },
        m,
      );
      return toDecisionDto(rows[0] as DecisionRow);
    });
  }

  /** Mailbox op `record_decision` (MCP `commander_record_decision`): sessiya o'z loyihasining jurnaliga yozadi. */
  async record(machineId: string, deviceId: string, claudeSessionId: string, raw: unknown): Promise<{ text: string }> {
    const p = RecordDecisionCallSchema.safeParse(raw);
    if (!p.success) throw new MessagingError('invalid_request', "Qaror maydonlari yaroqsiz (title, decision, reason majburiy)");
    const rows: Array<{ id: string; project_id: string | null; base_key: string | null }> = await this.dataSource.query(
      `SELECT s.id, s.project_id, ${BASE_KEY_SQL} AS base_key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
      [machineId, claudeSessionId],
    );
    const s = rows[0];
    if (!s) throw new MessagingError('session_unknown', "Center bu sessiyani hali bilmaydi (birinchi hook hodisasi kelgach urinib ko'ring)");
    if (!s.base_key) throw new MessagingError('group_unavailable', "Bu sessiya loyihaga bog'lanmagan: qaror jurnali yo'q");
    if (this.limiter.hit(s.id) > DECISION_LIMITS.recordLimit) throw new MessagingError('rate_limited', `Juda tez-tez: soatiga eng ko'pi ${DECISION_LIMITS.recordLimit} ta qaror`);
    const title = redactAndCap(p.data.title, 120);
    const baseKey = s.base_key;
    const out = await this.dataSource.transaction(async (m) => {
      const same: Array<{ id: string; title: string; status: string }> = await m.query(`SELECT id, title, status FROM project_decisions WHERE base_key = $1 AND status IN ('active', 'proposed')`, [baseKey]);
      const dup = same.find((x) => normTitle(x.title) === normTitle(title));
      let id: string;
      if (dup) {
        // Shu sarlavhali qaror bor: yangilanadi (taklif bo'lsa ham sessiya o'zi yozgani uchun faol qilinadi)
        await m.query(`UPDATE project_decisions SET decision = $2, reason = $3, alternatives = $4::jsonb, status = 'active', updated_at = now() WHERE id = $1`, [
          dup.id,
          redactAndCap(p.data.decision, 1000),
          redactAndCap(p.data.reason, 1000),
          JSON.stringify((p.data.alternatives ?? []).map((a) => redactAndCap(a, 200))),
        ]);
        id = dup.id;
      } else {
        const ins: Array<{ id: string }> = await m.query(
          `INSERT INTO project_decisions (base_key, project_id, title, decision, reason, alternatives, status, source, source_session_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', 'session', $7) RETURNING id`,
          [baseKey, s.project_id, title, redactAndCap(p.data.decision, 1000), redactAndCap(p.data.reason, 1000), JSON.stringify((p.data.alternatives ?? []).map((a) => redactAndCap(a, 200))), s.id],
        );
        id = (ins[0] as { id: string }).id;
      }
      await this.audit.record(
        // Matn YOZILMAYDI: faqat o'lchamlar
        { actorDeviceId: deviceId, actorKind: 'agentd', action: 'decision.recorded', target: id, details: { baseKey, updated: dup !== undefined, titleChars: title.length, decisionChars: p.data.decision.length, reasonChars: p.data.reason.length } },
        m,
      );
      return { id, updated: dup !== undefined };
    });
    return { text: out.updated ? `Qaror yangilandi: ${title}` : `Qaror jurnalga yozildi: ${title}` };
  }

  /**
   * Yangi sessiyaning BIRINCHI promptida kontekstga tushadigan blok (`cc-hook --inbox` -> mailbox `deliver`). Bir sessiyaga bir marta
   * (`decision_injections`); qarorlar yo'q bo'lsa `null`. FAIL-SAFE: har qanday xato `null` (sessiya buzilmaydi, log'ga yoziladi).
   */
  async injectionFor(machineId: string, claudeSessionId: string): Promise<string | null> {
    try {
      const rows: Array<{ id: string; base_key: string | null }> = await this.dataSource.query(
        `SELECT s.id, ${BASE_KEY_SQL} AS base_key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
        [machineId, claudeSessionId],
      );
      const s = rows[0];
      if (!s?.base_key) return null;
      const claimed: unknown[] = await this.dataSource.query(`INSERT INTO decision_injections (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING RETURNING session_id`, [s.id]);
      if (claimed.length === 0) return null;
      const decisions: DecisionRow[] = await this.dataSource.query(
        `SELECT * FROM project_decisions WHERE base_key = $1 AND status = 'active' ORDER BY created_at DESC LIMIT $2`,
        [s.base_key, DECISION_LIMITS.injectCount],
      );
      if (decisions.length === 0) return null;
      await this.dataSource.query(`UPDATE decision_injections SET decision_count = $2 WHERE session_id = $1`, [s.id, decisions.length]);
      return formatDecisionsContext(decisions.map((d) => ({ title: d.title, decision: d.decision, reason: d.reason, createdAt: d.created_at.toISOString() })));
    } catch (err) {
      this.logger.warn(`decision injection failed (session continues without it): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
