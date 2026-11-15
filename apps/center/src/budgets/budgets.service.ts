import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { BUDGET_LIMITS } from '@commander/contracts';
import type { BudgetOverrideBody, BudgetScopeKind, BudgetStatus, BudgetsResponse, PutBudgetBody } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { CommandsService } from '../commands/commands.service.js';
import { budgetDay, firstHardBlock, matchProjectByCwd, toStatus, weightedUsage } from './budget-logic.js';
import type { BudgetDayInfo, GateBlock, ProjectRef, TokenSums } from './budget-logic.js';

export interface BudgetActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip?: string | null;
}

interface BudgetRow {
  scope_kind: BudgetScopeKind;
  scope_key: string;
  daily_tokens: string;
  auto_stop: boolean;
  updated_by_device_id: string | null;
}

interface SumRow {
  key: string;
  i: number;
  o: number;
  cr: number;
  cc: number;
}

const SUMS = `COALESCE(SUM(tu.input_tokens), 0)::float8 AS i, COALESCE(SUM(tu.output_tokens), 0)::float8 AS o,
              COALESCE(SUM(tu.cache_read_tokens), 0)::float8 AS cr, COALESCE(SUM(tu.cache_creation_tokens), 0)::float8 AS cc`;

const sumsOf = (r: SumRow | undefined): TokenSums => ({ input: r?.i ?? 0, output: r?.o ?? 0, cacheRead: r?.cr ?? 0, cacheCreation: r?.cc ?? 0 });

/**
 * Kunlik byudjetlar (6.11). Sarf = shu Toshkent kunidagi vaznli tokenlar (xom `token_usage`: bugun har doim mavjud, retention 30 kun).
 * Qattiq chegara `CommandsService.create(session.start)` darvozasi orqali qo'llanadi: bitta nuqta dashboard, Telegram, navbat va
 * orkestratsiya yangi sessiyalarini qoplaydi. Orkestratsiyaning mavjud sessiyaga prompt'i va navbat tiki alohida tekshiradi
 * (`checkSession` / `check`). Darvoza xato bersa buyruq O'TKAZILADI (byudjet xavfsizlik chegarasi emas, ish to'xtamasin) va xato log'ga yoziladi.
 */
@Injectable()
export class BudgetsService implements OnModuleInit {
  private readonly logger = new Logger(BudgetsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit(): void {
    this.commands.setStartGate(async ({ machineId, cwd }) => {
      try {
        const block = await this.check(machineId, cwd);
        return block ? { code: 'budget_exceeded', message: block.message } : null;
      } catch (err) {
        this.logger.error(`budget gate failed (command allowed): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });
  }

  // --- o'qish ----------------------------------------------------------------------------------

  private async loadStatuses(rows: BudgetRow[], d: BudgetDayInfo): Promise<BudgetStatus[]> {
    if (rows.length === 0) return [];
    const mKeys = rows.filter((r) => r.scope_kind === 'machine').map((r) => r.scope_key);
    const pKeys = rows.filter((r) => r.scope_kind === 'project').map((r) => r.scope_key);
    const [mSums, pSums, mLabels, pLabels, overrides] = await Promise.all([
      mKeys.length
        ? this.dataSource.query(`SELECT tu.machine_id::text AS key, ${SUMS} FROM token_usage tu WHERE tu.ts >= $1 AND tu.ts < $2 AND tu.machine_id = ANY($3::uuid[]) GROUP BY 1`, [d.start, d.resetsAt, mKeys])
        : [],
      pKeys.length
        ? this.dataSource.query(
            `SELECT COALESCE(p.repo_key, p.id::text) AS key, ${SUMS}
               FROM token_usage tu JOIN projects p ON p.id = tu.project_id
              WHERE tu.ts >= $1 AND tu.ts < $2 AND COALESCE(p.repo_key, p.id::text) = ANY($3::text[]) GROUP BY 1`,
            [d.start, d.resetsAt, pKeys],
          )
        : [],
      mKeys.length ? this.dataSource.query(`SELECT id::text AS key, COALESCE(display_name, hostname, slug) AS label FROM machines WHERE id = ANY($1::uuid[])`, [mKeys]) : [],
      pKeys.length
        ? this.dataSource.query(
            `SELECT COALESCE(p.repo_key, p.id::text) AS key, (array_agg(p.name ORDER BY p.last_snapshot_at DESC NULLS LAST))[1] AS label
               FROM projects p WHERE COALESCE(p.repo_key, p.id::text) = ANY($1::text[]) GROUP BY 1`,
            [pKeys],
          )
        : [],
      this.dataSource.query(`SELECT scope_kind, scope_key, extra_tokens::float8 AS extra FROM budget_overrides WHERE day = $1::date`, [d.day]),
    ]);
    const used = (kind: BudgetScopeKind, key: string): number => weightedUsage(sumsOf(((kind === 'machine' ? mSums : pSums) as SumRow[]).find((r) => r.key === key)));
    const label = (kind: BudgetScopeKind, key: string): string => ((kind === 'machine' ? mLabels : pLabels) as Array<{ key: string; label: string }>).find((r) => r.key === key)?.label ?? key;
    const extra = (kind: BudgetScopeKind, key: string): number => (overrides as Array<{ scope_kind: string; scope_key: string; extra: number }>).find((o) => o.scope_kind === kind && o.scope_key === key)?.extra ?? 0;
    return rows.map((r) =>
      toStatus({ scopeKind: r.scope_kind, scopeKey: r.scope_key, label: label(r.scope_kind, r.scope_key), dailyTokens: Number(r.daily_tokens), extra: extra(r.scope_kind, r.scope_key), used: used(r.scope_kind, r.scope_key), autoStop: r.auto_stop }),
    );
  }

  async status(now: Date = new Date()): Promise<BudgetsResponse> {
    const d = budgetDay(now);
    const rows: BudgetRow[] = await this.dataSource.query(`SELECT scope_kind, scope_key, daily_tokens::text, auto_stop, updated_by_device_id FROM budgets ORDER BY scope_kind, scope_key LIMIT ${BUDGET_LIMITS.maxBudgets}`);
    return { day: d.day, resetsAt: d.resetsAt.toISOString(), items: await this.loadStatuses(rows, d) };
  }

  /** Qurilma tanlash uchun: byudjet egasi (auto-stop va ogohlantirishlar shu qurilma nomidan). */
  async budgetRows(): Promise<BudgetRow[]> {
    return this.dataSource.query(`SELECT scope_kind, scope_key, daily_tokens::text, auto_stop, updated_by_device_id FROM budgets`);
  }

  /** Mashina + cwd uchun amal qiluvchi byudjetlar (loyiha cwd'dan aniqlanadi; loyihasiz cwd faqat mashina byudjetiga tushadi). */
  private async applicable(machineId: string, cwd: string | null): Promise<BudgetRow[]> {
    let projectKey: string | null = null;
    if (cwd) {
      const projects: ProjectRef[] = await this.dataSource.query(`SELECT id, path, COALESCE(repo_key, id::text) AS key, name FROM projects WHERE machine_id = $1`, [machineId]);
      projectKey = matchProjectByCwd(cwd, projects)?.key ?? null;
    }
    return this.dataSource.query(
      `SELECT scope_kind, scope_key, daily_tokens::text, auto_stop, updated_by_device_id FROM budgets
        WHERE (scope_kind = 'machine' AND scope_key = $1) OR (scope_kind = 'project' AND scope_key = $2)`,
      [machineId, projectKey],
    );
  }

  /** Yangi sessiya/navbat/orkestratsiya qadami uchun: qattiq chegara bormi (`null` = ruxsat). Byudjet bo'lmasa DB'ga sarf so'rovi YO'Q. */
  async check(machineId: string, cwd: string | null, now: Date = new Date()): Promise<GateBlock | null> {
    const rows = await this.applicable(machineId, cwd);
    if (rows.length === 0) return null;
    return firstHardBlock(await this.loadStatuses(rows, budgetDay(now)));
  }

  /** Mavjud sessiyaga yangi ish topshirish (orkestratsiya `session.prompt`): sessiya mashinasi/loyihasi bo'yicha. */
  async checkSession(sessionId: string, now: Date = new Date()): Promise<GateBlock | null> {
    const s: Array<{ machine_id: string; cwd: string | null }> = await this.dataSource.query(`SELECT machine_id, cwd FROM sessions WHERE id = $1`, [sessionId]);
    return s[0] ? this.check(s[0].machine_id, s[0].cwd, now) : null;
  }

  // --- yozish (elevated, audit) ----------------------------------------------------------------

  private async assertScope(m: EntityManager, kind: BudgetScopeKind, key: string): Promise<void> {
    const rows: unknown[] =
      kind === 'machine'
        ? /^[0-9a-f-]{36}$/i.test(key)
          ? await m.query(`SELECT 1 FROM machines WHERE id = $1 AND status = 'active' AND merged_into_id IS NULL`, [key])
          : []
        : await m.query(`SELECT 1 FROM projects WHERE COALESCE(repo_key, id::text) = $1 LIMIT 1`, [key]);
    if (rows.length === 0) throw new NotFoundException({ error: 'not_found', message: kind === 'machine' ? 'Machine not found' : 'Project not found' });
  }

  async put(body: PutBudgetBody, actor: BudgetActor, now: Date = new Date()): Promise<BudgetsResponse> {
    await this.dataSource.transaction(async (m) => {
      await this.assertScope(m, body.scopeKind, body.scopeKey);
      const target = `${body.scopeKind}:${body.scopeKey.slice(0, 120)}`;
      if (body.dailyTokens === null) {
        await m.query(`DELETE FROM budgets WHERE scope_kind = $1 AND scope_key = $2`, [body.scopeKind, body.scopeKey]);
        await m.query(`DELETE FROM budget_alerts WHERE scope_kind = $1 AND scope_key = $2`, [body.scopeKind, body.scopeKey]);
        await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'budget.removed', target, ip: actor.ip ?? null, details: { scope_kind: body.scopeKind } }, m);
        return;
      }
      const count: Array<{ n: number }> = await m.query(`SELECT count(*)::int AS n FROM budgets`);
      const exists: unknown[] = await m.query(`SELECT 1 FROM budgets WHERE scope_kind = $1 AND scope_key = $2`, [body.scopeKind, body.scopeKey]);
      if (exists.length === 0 && (count[0]?.n ?? 0) >= BUDGET_LIMITS.maxBudgets) throw new ConflictException({ error: 'too_many_budgets', message: 'Too many budgets' });
      await m.query(
        `INSERT INTO budgets (scope_kind, scope_key, daily_tokens, auto_stop, updated_by_device_id)
         VALUES ($1, $2, $3, COALESCE($4, false), $5)
         ON CONFLICT (scope_kind, scope_key) DO UPDATE
           SET daily_tokens = EXCLUDED.daily_tokens, auto_stop = COALESCE($4, budgets.auto_stop), updated_by_device_id = EXCLUDED.updated_by_device_id, updated_at = now()`,
        [body.scopeKind, body.scopeKey, body.dailyTokens, body.autoStop ?? null, actor.deviceId],
      );
      // chegara o'zgardi: bugungi ogohlantirishlar qayta hisoblanadi
      await m.query(`DELETE FROM budget_alerts WHERE scope_kind = $1 AND scope_key = $2 AND day = $3::date`, [body.scopeKind, body.scopeKey, budgetDay(now).day]);
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'budget.set', target, ip: actor.ip ?? null, details: { scope_kind: body.scopeKind, daily_tokens: body.dailyTokens, auto_stop: body.autoStop ?? null } },
        m,
      );
    });
    return this.status(now);
  }

  /** "Bugun uchun +X": qo'shiladi (jami `maxOverrideTokens` gacha), yarim kechada o'z-o'zidan amal qilmay qoladi. Faqat byudjeti bor scope. */
  async override(body: BudgetOverrideBody, actor: BudgetActor, now: Date = new Date()): Promise<BudgetsResponse> {
    const day = budgetDay(now).day;
    await this.dataSource.transaction(async (m) => {
      const has: unknown[] = await m.query(`SELECT 1 FROM budgets WHERE scope_kind = $1 AND scope_key = $2`, [body.scopeKind, body.scopeKey]);
      if (has.length === 0) throw new NotFoundException({ error: 'not_found', message: 'No budget is set for this scope' });
      await m.query(
        `INSERT INTO budget_overrides (scope_kind, scope_key, day, extra_tokens, set_by_device_id) VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (scope_kind, scope_key, day) DO UPDATE
           SET extra_tokens = LEAST(budget_overrides.extra_tokens + EXCLUDED.extra_tokens, $6), set_by_device_id = EXCLUDED.set_by_device_id, updated_at = now()`,
        [body.scopeKind, body.scopeKey, day, body.extraTokens, actor.deviceId, BUDGET_LIMITS.maxOverrideTokens],
      );
      // limit oshdi: bugungi ogohlantirishlar qayta ishlay oladi (yana 80%/100% ga yetsa)
      await m.query(`DELETE FROM budget_alerts WHERE scope_kind = $1 AND scope_key = $2 AND day = $3::date`, [body.scopeKind, body.scopeKey, day]);
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'budget.override', target: `${body.scopeKind}:${body.scopeKey.slice(0, 120)}`, ip: actor.ip ?? null, details: { scope_kind: body.scopeKind, extra_tokens: body.extraTokens, day } },
        m,
      );
    });
    return this.status(now);
  }
}
