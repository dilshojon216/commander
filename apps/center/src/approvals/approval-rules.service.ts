import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { RULE_LIMITS } from '@commander/contracts';
import type { ApprovalRuleDto, ApprovalTarget, CreateApprovalRuleBody, ListApprovalRulesQuery, ListApprovalRulesResponse, RuleScope } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { findMatchingRule, ruleStatus, underRateCap } from './approval-rules-logic.js';
import type { RuleLike } from './approval-rules-logic.js';
import { isStepUpExemptDevice } from './step-up-exempt.js';

/** Bir vaqtda faol qoidalar chegarasi (suiiste'mol/xato bazani to'ldirmasin). */
export const MAX_ACTIVE_RULES = 100;

export interface RuleActor {
  deviceId: string;
  actorKind: AuditActorKind;
  ip: string | null;
  /** Telegram ichidagi inline tasdiq (bot o'zi o'rnatadi; REST controller HECH QACHON o'rnatmaydi). */
  confirmation?: 'telegram_inline';
}

interface RuleRow {
  id: string;
  scope: RuleScope;
  scope_ref: string;
  tools: string[];
  path_globs: string[];
  expires_at: Date;
  created_by_device_id: string;
  created_at: Date;
  revoked_at: Date | null;
  scope_label: string | null;
  auto_count: number;
}

const SELECT_RULE = `
  SELECT r.id::text AS id, r.scope, r.scope_ref, r.tools, r.path_globs, r.expires_at, r.created_by_device_id, r.created_at, r.revoked_at,
         CASE r.scope
           WHEN 'session' THEN (SELECT COALESCE(s.name, s.project) FROM sessions s WHERE s.id::text = r.scope_ref)
           WHEN 'project' THEN (SELECT p.name FROM projects p WHERE p.id::text = r.scope_ref)
           ELSE r.scope_ref
         END AS scope_label,
         (SELECT count(*)::int FROM approvals a WHERE a.auto_rule_id = r.id) AS auto_count
    FROM approval_rules r`;

export function toRuleDto(r: RuleRow, now: Date): ApprovalRuleDto {
  return {
    id: Number(r.id),
    scope: r.scope,
    scopeRef: r.scope_ref,
    scopeLabel: r.scope_label,
    tools: r.tools,
    pathGlobs: r.path_globs,
    expiresAt: r.expires_at.toISOString(),
    createdByDeviceId: r.created_by_device_id,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    status: ruleStatus({ expiresAt: r.expires_at, revokedAt: r.revoked_at }, now),
    autoCount: r.auto_count,
  };
}

export interface AutoAllowHit {
  ruleId: number;
  scope: RuleScope;
}

/**
 * Avto-ruxsat qoidalari (2.13): CRUD + `approval.request` uchun moslashtirish. Mantiq: `approval-rules-logic.ts` (sof).
 * Yaratish step-up talab qiladi: faqat egasi tanlagan istisno qurilma (lokal dashboard) yoki Telegram ichidagi inline tasdiq;
 * boshqa qurilmalar 403 `step_up_required` (fail-closed). Audit: `approval_rule.created|revoked` amal bilan BIR tranzaksiyada.
 */
@Injectable()
export class ApprovalRulesService {
  private readonly logger = new Logger(ApprovalRulesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly lockdown: LockdownService,
  ) {}

  async create(body: CreateApprovalRuleBody, actor: RuleActor, now: Date = new Date()): Promise<ApprovalRuleDto> {
    if ((await this.lockdown.state()).enabled) throw new ForbiddenException({ error: 'lockdown', message: 'Lockdown is active: rules cannot be created' });
    const exempt = await isStepUpExemptDevice(this.dataSource, actor.deviceId);
    const telegramConfirmed = actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram';
    if (!exempt && !telegramConfirmed) {
      throw new ForbiddenException({ error: 'step_up_required', message: 'Creating an auto-approval rule needs confirmation: create it from Telegram or the local dashboard' });
    }
    await this.assertScopeExists(body.scope, body.scopeRef);

    const expiresAt = new Date(now.getTime() + body.ttlSeconds * 1000);
    const id = await this.dataSource.transaction(async (m) => {
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM approval_rules WHERE revoked_at IS NULL AND expires_at > $1`, [now])) as Array<{ n: number }>;
      if (n >= MAX_ACTIVE_RULES) throw new ConflictException({ error: 'too_many_rules', message: `At most ${MAX_ACTIVE_RULES} active rules` });
      const rows: Array<{ id: string }> = await m.query(
        `INSERT INTO approval_rules (scope, scope_ref, tools, path_globs, expires_at, created_by_device_id, created_at)
         VALUES ($1, $2, $3::text[], $4::text[], $5, $6, $7) RETURNING id::text AS id`,
        [body.scope, body.scopeRef, body.tools, body.pathGlobs, expiresAt, actor.deviceId, now],
      );
      const ruleId = rows[0]!.id;
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'approval_rule.created',
          target: ruleId,
          ip: actor.ip,
          details: {
            scope: body.scope,
            scope_ref: body.scopeRef,
            tools: body.tools,
            path_glob_count: body.pathGlobs.length,
            expires_at: expiresAt.toISOString(),
            confirmation: telegramConfirmed ? 'telegram_inline' : 'exempt_device',
          },
        },
        m,
      );
      return ruleId;
    });
    return this.getDto(id, now);
  }

  /** Revoke: idempotent (allaqachon bekor = `revoked:false`). Lockdown'da ham ruxsat (xavfsiz tomon). */
  async revoke(id: string, actor: RuleActor, now: Date = new Date()): Promise<{ rule: ApprovalRuleDto; revoked: boolean }> {
    const revoked = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string }> = await m.query(
        // CTE: TypeORM `query()` UPDATE..RETURNING uchun [qatorlar, soni] qaytaradi; SELECT bilan oddiy massiv olinadi.
        `WITH upd AS (UPDATE approval_rules SET revoked_at = $2, revoked_by_device_id = $3 WHERE id = $1::bigint AND revoked_at IS NULL RETURNING id)
         SELECT id::text AS id FROM upd`,
        [id, now, actor.deviceId],
      );
      if (rows.length === 0) return false;
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'approval_rule.revoked', target: id, ip: actor.ip, details: {} }, m);
      return true;
    });
    return { rule: await this.getDto(id, now), revoked };
  }

  async getDto(id: string, now: Date = new Date()): Promise<ApprovalRuleDto> {
    if (!/^[0-9]{1,18}$/.test(id)) throw new NotFoundException({ error: 'not_found', message: 'Rule not found' });
    const rows: RuleRow[] = await this.dataSource.query(`${SELECT_RULE} WHERE r.id = $1::bigint`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Rule not found' });
    return toRuleDto(rows[0], now);
  }

  async list(q: ListApprovalRulesQuery, now: Date = new Date()): Promise<ListApprovalRulesResponse> {
    const rows: RuleRow[] = await this.dataSource.query(
      `${SELECT_RULE}
        WHERE ($1::text IS NULL OR r.scope = $1) AND ($2::text IS NULL OR r.scope_ref = $2)
          AND ($3::boolean OR (r.revoked_at IS NULL AND r.expires_at > $4))
        ORDER BY (r.revoked_at IS NULL AND r.expires_at > $4) DESC, r.id DESC
        LIMIT $5`,
      [q.scope ?? null, q.scopeRef ?? null, q.includeInactive, now, q.includeInactive ? 50 + MAX_ACTIVE_RULES : MAX_ACTIVE_RULES],
    );
    return { rules: rows.map((r) => toRuleDto(r, now)) };
  }

  /**
   * `approval.request` uchun mos faol qoida. `m` = handleRequest tranzaksiyasi (kvota hisobi va qaror bir xil snapshot'da).
   * Sessiya markazda topilmasa (hodisa hali kelmagan) qoida YO'Q: scope aniqlanmaydi, qo'lda tasdiq.
   * Soatlik cheklovdan oshgan qoida o'tkazib yuboriladi (keyingi mos qoida, bo'lmasa qo'lda tasdiq).
   */
  async findAutoAllow(m: EntityManager, machineId: string, claudeSessionId: string, toolName: string, target: ApprovalTarget | undefined, now: Date): Promise<AutoAllowHit | null> {
    const rows: Array<{ id: string; scope: RuleScope; tools: string[]; path_globs: string[]; expires_at: Date; revoked_at: Date | null }> = await m.query(
      `SELECT r.id::text AS id, r.scope, r.tools, r.path_globs, r.expires_at, r.revoked_at
         FROM sessions s
         JOIN approval_rules r ON r.revoked_at IS NULL AND r.expires_at > $3 AND $4 = ANY (r.tools)
          AND ( (r.scope = 'session' AND r.scope_ref = s.id::text)
             OR (r.scope = 'project' AND s.project_id IS NOT NULL AND r.scope_ref = s.project_id::text)
             OR (r.scope = 'repo' AND r.scope_ref = (SELECT p.repo_key FROM projects p WHERE p.id = s.project_id)) )
        WHERE s.machine_id = $1 AND s.claude_session_id = $2
        ORDER BY r.id`,
      [machineId, claudeSessionId, now, toolName],
    );
    const candidates = rows.map((r) => ({ id: Number(r.id), scope: r.scope, tools: r.tools, pathGlobs: r.path_globs, expiresAt: r.expires_at, revokedAt: r.revoked_at }));
    let pool = candidates;
    for (let guard = 0; guard < 8 && pool.length > 0; guard += 1) {
      const hit = findMatchingRule<RuleLike & { scope: RuleScope }>(pool, { toolName, target }, now);
      if (!hit) return null;
      const used = await this.autoCountLastHour(m, hit.id, now);
      if (underRateCap(used)) return { ruleId: hit.id, scope: hit.scope };
      this.logger.warn(`rule #${hit.id} hit the hourly cap (${RULE_LIMITS.maxAutoPerHour}); falling back to manual approval`);
      pool = pool.filter((r) => r.id !== hit.id);
    }
    return null;
  }

  private async autoCountLastHour(m: EntityManager, ruleId: number, now: Date): Promise<number> {
    const rows: Array<{ n: number }> = await m.query(
      `SELECT count(*)::int AS n FROM approvals WHERE auto_rule_id = $1::bigint AND requested_at > $2::timestamptz - interval '1 hour'`,
      [String(ruleId), now],
    );
    return rows[0]?.n ?? 0;
  }

  private async assertScopeExists(scope: RuleScope, ref: string): Promise<void> {
    const sql =
      scope === 'session'
        ? `SELECT 1 FROM sessions WHERE id = $1::uuid`
        : scope === 'project'
          ? `SELECT 1 FROM projects WHERE id = $1::uuid`
          : `SELECT 1 FROM projects WHERE repo_key = $1 LIMIT 1`;
    const rows: unknown[] = await this.dataSource.query(sql, [ref]);
    if (rows.length === 0) throw new NotFoundException({ error: 'scope_not_found', message: `No such ${scope} for this rule` });
  }
}
