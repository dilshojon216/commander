import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { APPROVAL_LIMITS, AskAnswersSchema, AskQuestionsSchema, PLAN_REMOTE_APPROVE_SUPPORTED, QUESTION_LIMITS, QUESTION_TOOL_NAME, validateAskAnswers } from '@commander/contracts';
import type {
  ApprovalBehavior,
  AskAnswer,
  AskQuestion,
  ApprovalCancelPayload,
  ApprovalDecisionBody,
  ApprovalDecisionResponse,
  ApprovalDto,
  ApprovalRequestPayload,
  ApprovalStatus,
  ListApprovalsQuery,
  ListApprovalsResponse,
} from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { ApprovalRulesService } from './approval-rules.service.js';
import { ApprovalOverloadError, ApprovalRejectedError } from './approvals.errors.js';
import { APPROVALS_OPTIONS } from './approvals.options.js';
import type { ApprovalsOptions } from './approvals.options.js';
import { behaviorForStatus, decideApproval, normalizeDeadline, sessionStatusAfter } from './approval-state.js';

/** Bitta mashinada bir vaqtda kutayotgan approval chegarasi (agent xatosi/hujum bazani to'ldirmasin). */
export const MAX_PENDING_PER_MACHINE = 50;

export interface DecisionActor {
  deviceId: string;
  actorKind: AuditActorKind;
  ip: string | null;
}

interface ApprovalRow {
  id: string;
  machine_id: string;
  machine_slug: string;
  session_uuid: string | null;
  claude_session_id: string;
  project_name: string | null;
  cwd: string;
  tool_name: string;
  tool_input_redacted: string;
  tool_input_full_hash: string;
  status: ApprovalStatus;
  decision_message: string | null;
  decided_by_device_id: string | null;
  decided_at: Date | null;
  delivered_at: Date | null;
  requested_at: Date;
  deadline: Date;
  resolved_at: Date | null;
  kind: 'tool' | 'plan' | 'question';
  plan_text: string | null;
  auto_rule_id: string | null;
  questions: unknown;
  answers: unknown;
}

/** Reja matni (30 kun) saqlash muddati; undan keyin `plan_text` NULL qilinadi. */
export const PLAN_RETENTION_DAYS = 30;
const PLAN_CLEANUP_EVERY_MS = 60 * 60_000;

const SELECT_DTO = `
  SELECT a.id, a.machine_id, m.slug AS machine_slug, s.id AS session_uuid, a.claude_session_id,
         COALESCE(p.name, s.project) AS project_name, a.cwd, a.tool_name, a.tool_input_redacted,
         a.tool_input_full_hash, a.status, a.decision_message, a.decided_by_device_id, a.decided_at,
         a.delivered_at, a.requested_at, a.deadline, a.resolved_at, a.kind, a.plan_text, a.auto_rule_id::text AS auto_rule_id, a.questions, a.answers
    FROM approvals a
    JOIN machines m ON m.id = a.machine_id
    LEFT JOIN sessions s ON s.machine_id = a.machine_id AND s.claude_session_id = a.claude_session_id
    LEFT JOIN projects p ON p.id = s.project_id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** jsonb ustunini kontrakt bo'yicha o'qiydi; yaroqsiz/yo'q = null (eski qatorlar DTO'ni yiqitmasin). */
function parseJson<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null {
  if (v === null || v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
}

/** Savollar: har matn maydoni center'da QAYTA redakt qilinadi va kesiladi (agentga ishonilmaydi). */
export function sanitizeQuestions(qs: readonly AskQuestion[]): AskQuestion[] {
  return qs.map((q) => ({
    question: redactAndCap(q.question, QUESTION_LIMITS.questionChars) || '?',
    header: redactAndCap(q.header, QUESTION_LIMITS.headerChars),
    multiSelect: q.multiSelect,
    options: q.options.map((o) => {
      const preview = o.preview === undefined ? '' : redactAndCap(o.preview, QUESTION_LIMITS.previewChars);
      return {
        label: redactAndCap(o.label, QUESTION_LIMITS.labelChars) || '?',
        description: redactAndCap(o.description, QUESTION_LIMITS.descriptionChars),
        ...(preview !== '' ? { preview } : {}),
      };
    }),
  }));
}

/** Erkin matn javobi qayta redakt qilinadi (saqlanadi VA agentga shu holda yetkaziladi: bir xil qiymat). */
export function sanitizeAnswers(answers: readonly AskAnswer[]): AskAnswer[] {
  return answers.map((a) => {
    const other = a.other === undefined ? '' : redactAndCap(a.other, QUESTION_LIMITS.otherChars).trim();
    return { q: a.q, picks: a.picks, ...(other !== '' ? { other } : {}) };
  });
}

export function toApprovalDto(r: ApprovalRow): ApprovalDto {
  const decided = r.status === 'approved' || r.status === 'denied';
  return {
    id: r.id,
    machineId: r.machine_id,
    machineSlug: r.machine_slug,
    sessionId: r.session_uuid,
    claudeSessionId: r.claude_session_id,
    projectName: r.project_name,
    cwd: r.cwd,
    toolName: r.tool_name,
    toolInputRedacted: r.tool_input_redacted,
    toolInputFullHash: r.tool_input_full_hash,
    status: r.status,
    behavior: behaviorForStatus(r.status),
    decisionMessage: r.decision_message,
    decidedByDeviceId: r.decided_by_device_id,
    decidedAt: iso(r.decided_at),
    delivered: decided ? r.delivered_at !== null : null,
    requestedAt: r.requested_at.toISOString(),
    deadline: r.deadline.toISOString(),
    resolvedAt: iso(r.resolved_at),
    kind: r.kind,
    plan: r.plan_text,
    autoRuleId: r.auto_rule_id === null ? null : Number(r.auto_rule_id),
    questions: parseJson(AskQuestionsSchema, r.questions),
    answers: parseJson(AskAnswersSchema, r.answers),
  };
}

/**
 * Remote permission (1.7, PLAN 6.4): agentd so'rovi -> `approvals` -> klientlar qarori -> agentd.
 *
 * Kafolatlar:
 *  - birinchi qaror yutadi (qator qulfi + holat mashinasi), takroriy bir xil qaror idempotent, qolgani 409;
 *  - qaror audit qatori BILAN BIR tranzaksiyada yoziladi va faqat COMMIT'dan keyin agentga yuboriladi
 *    ("audit yozuvisiz amal yo'q"; audit yozilmasa qaror qabul qilinmaydi);
 *  - hech qachon avtomatik allow yo'q: deadline o'tsa `expired` + agentga `approval.expired` (lokal prompt);
 *  - lockdown: masofaviy `allow` 403, `deny` ruxsat;
 *  - markaz xom kiritmani saqlamaydi; kelgan `toolInputRedacted` ham qayta redact() va kesishdan o'tadi.
 */
@Injectable()
export class ApprovalsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(ApprovalsService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private lastPlanCleanup = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly lockdown: LockdownService,
    private readonly dispatch: AgentDispatchService,
    private readonly bus: RealtimeBus,
    private readonly rules: ApprovalRulesService,
    @Inject(APPROVALS_OPTIONS) private readonly options: ApprovalsOptions,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweepExpired().catch((err: unknown) => this.logger.error(`expiry sweep failed: ${err instanceof Error ? err.message : String(err)}`)), this.options.sweepMs);
    this.sweepTimer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // --- agent -> center -------------------------------------------------------------------------

  /**
   * `approval.request`. Idempotent (`approvalId` = PK). Boshqa mashinaning id'si bilan to'qnashuv rad etiladi.
   * Allaqachon hal bo'lgan so'rovning takroriy yuborilishi natijani agentga qayta yetkazadi.
   */
  async handleRequest(machineId: string, p: ApprovalRequestPayload, now: Date = new Date()): Promise<{ created: boolean }> {
    const { deadline, alreadyExpired } = normalizeDeadline(p.deadline, now);
    const input = redactAndCap(p.toolInputRedacted, APPROVAL_LIMITS.toolInputMaxChars);
    const plan = p.kind === 'plan' && p.plan !== undefined ? redactAndCap(p.plan, APPROVAL_LIMITS.planMaxChars) : null;
    const questions = p.kind === 'question' && p.questions !== undefined ? JSON.stringify(sanitizeQuestions(p.questions)) : null;
    // Lockdown: avto-ruxsat qoidalari ishlamaydi (so'rov qo'lda tasdiqqa tushadi; allow baribir rad etiladi).
    const lockdown = (await this.lockdown.state()).enabled;

    const result = await this.dataSource.transaction(async (m) => {
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM approvals WHERE machine_id = $1 AND status = 'pending'`, [machineId])) as Array<{ n: number }>;
      const existingRows: Array<{ id: string; machine_id: string; status: ApprovalStatus }> = await m.query(`SELECT id, machine_id, status FROM approvals WHERE id = $1`, [p.approvalId]);
      const existing = existingRows[0];
      if (existing) {
        if (existing.machine_id !== machineId) throw new ApprovalRejectedError('approvalId belongs to another machine');
        return { created: false as const, status: existing.status, autoRuleId: null };
      }
      if (n >= MAX_PENDING_PER_MACHINE && !alreadyExpired) {
        throw new ApprovalOverloadError('too many pending approvals on this machine', 30_000);
      }

      // Avto-ruxsat (2.13): faqat oddiy tool so'rovi, lockdown yo'q, muddati o'tmagan. Reja (ExitPlanMode) hech qachon.
      const hit =
        !alreadyExpired && !lockdown && p.kind === 'tool'
          ? await this.rules.findAutoAllow(m, machineId, p.claudeSessionId, p.toolName, p.target, now)
          : null;
      if (hit) {
        await m.query(
          `INSERT INTO approvals
             (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash,
              status, requested_at, deadline, decided_at, resolved_at, auto_rule_id, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, $9, $8, $8, $10::bigint, 'tool')`,
          [p.approvalId, machineId, p.claudeSessionId, p.cwd, p.toolName, input, p.toolInputFullHash, now, deadline, String(hit.ruleId)],
        );
        // Audit dispatchdan OLDIN va qator bilan atomik (qoida 1): audit yozilmasa avto-ruxsat ham yo'q.
        await this.audit.record(
          {
            actorDeviceId: null,
            actorKind: 'system',
            action: 'approval.auto_allowed',
            target: p.approvalId,
            ip: null,
            details: { rule_id: hit.ruleId, rule_scope: hit.scope, tool_name: p.toolName, machine_id: machineId, claude_session_id: p.claudeSessionId },
          },
          m,
        );
        return { created: true as const, status: 'approved' as const, autoRuleId: hit.ruleId };
      }

      const status: ApprovalStatus = alreadyExpired ? 'expired' : 'pending';
      let prevStatus: string | null = null;
      if (!alreadyExpired) prevStatus = await this.markSessionAwaiting(m, machineId, p.claudeSessionId);
      await m.query(
        `INSERT INTO approvals
           (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash,
            status, requested_at, deadline, resolved_at, prev_session_status, kind, plan_text, questions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
        [p.approvalId, machineId, p.claudeSessionId, p.cwd, p.toolName, input, p.toolInputFullHash, status, now, deadline, alreadyExpired ? now : null, prevStatus, p.kind, plan, questions],
      );
      return { created: true as const, status, autoRuleId: null };
    });

    if (result.created) {
      if (result.autoRuleId !== null) {
        // Qaror yuborish: audit allaqachon commit bo'lgan. `created` e'lon qilinmaydi (Telegram/UI shovqini yo'q), faqat `resolved`.
        const delivered = this.dispatch.send(machineId, 'approval.decision', { approvalId: p.approvalId, behavior: 'allow', decidedAt: now.getTime() });
        if (delivered) await this.dataSource.query(`UPDATE approvals SET delivered_at = now() WHERE id = $1`, [p.approvalId]);
        this.bus.publish({ type: 'approval.resolved', approvalId: p.approvalId });
        return { created: true };
      }
      this.bus.publish({ type: 'sessions.changed', refs: [{ machineId, claudeSessionId: p.claudeSessionId }] });
      if (result.status === 'expired') {
        this.dispatch.send(machineId, 'approval.expired', { approvalId: p.approvalId, expiredAt: now.getTime() });
        this.bus.publish({ type: 'approval.resolved', approvalId: p.approvalId });
      } else {
        this.bus.publish({ type: 'approval.created', approvalId: p.approvalId });
      }
    } else {
      await this.redeliverOne(machineId, p.approvalId);
    }
    return { created: result.created };
  }

  /** `approval.cancel`: agent so'rov lokal hal bo'lganini bildirdi. Faqat `pending` bekor qilinadi (aks holda no-op). */
  async handleCancel(machineId: string, p: ApprovalCancelPayload): Promise<{ cancelled: boolean }> {
    const cancelled = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ claude_session_id: string }> = await m.query(
        `WITH upd AS (
           UPDATE approvals SET status = 'cancelled', resolved_at = now()
            WHERE id = $1 AND machine_id = $2 AND status = 'pending'
           RETURNING claude_session_id
         ) SELECT claude_session_id FROM upd`,
        [p.approvalId, machineId],
      );
      const row = rows[0];
      if (!row) return null;
      await this.restoreSession(m, machineId, row.claude_session_id, 'cancelled');
      return row.claude_session_id;
    });
    if (cancelled === null) return { cancelled: false };
    this.bus.publish({ type: 'sessions.changed', refs: [{ machineId, claudeSessionId: cancelled }] });
    this.bus.publish({ type: 'approval.resolved', approvalId: p.approvalId });
    return { cancelled: true };
  }

  // --- klient -> center ------------------------------------------------------------------------

  /**
   * `POST /v1/approvals/:id/decision`. Audit (`approval.decided`) qarorning o'zi bilan bir tranzaksiyada va
   * agentga yuborishdan OLDIN commit bo'ladi.
   */
  async decide(id: string, body: ApprovalDecisionBody, actor: DecisionActor, now: Date = new Date()): Promise<ApprovalDecisionResponse> {
    const lockdown = (await this.lockdown.state()).enabled;

    const txResult = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string; machine_id: string; claude_session_id: string; tool_name: string; kind: 'tool' | 'plan' | 'question'; status: ApprovalStatus; deadline: Date; decided_by_device_id: string | null; questions: unknown }> =
        await m.query(
          `SELECT id, machine_id, claude_session_id, tool_name, kind, status, deadline, decided_by_device_id, questions FROM approvals WHERE id = $1 FOR UPDATE`,
          [id],
        );
      const row = rows[0];
      if (!row) throw new NotFoundException({ error: 'not_found', message: 'Approval not found' });
      // ExitPlanMode: Claude Code hook `allow` ni qabul qilmaydi (terminal dialogi ochiq qoladi), shu sabab yolg'on
      // "tasdiqlandi" holati yaratmaymiz. Fikr bilan `deny` ishlaydi (qarang contracts `PLAN_REMOTE_APPROVE_SUPPORTED`).
      if (row.kind === 'plan' && body.behavior === 'allow' && !PLAN_REMOTE_APPROVE_SUPPORTED) {
        throw new UnprocessableEntityException({
          error: 'plan_approve_unsupported',
          message: 'Claude Code does not accept a remote allow for ExitPlanMode: approve the plan in the terminal, or deny with feedback so Claude revises it',
        });
      }

      // AskUserQuestion (6.13): `allow` faqat to'liq va to'g'ri javoblar bilan; javobsiz allow (jumladan eski agentd'ning
      // `tool` sifatida yuborgan AskUserQuestion'i) hech qachon qabul qilinmaydi (jim "javobsiz" allow yo'q).
      let answers: AskAnswer[] | null = null;
      if (row.kind !== 'question' && body.answers !== undefined) {
        throw new UnprocessableEntityException({ error: 'answers_not_applicable', message: 'answers are only valid for question approvals' });
      }
      if (body.behavior === 'allow' && (row.kind === 'question' || row.tool_name === QUESTION_TOOL_NAME)) {
        const stored = row.kind === 'question' ? parseJson(AskQuestionsSchema, row.questions) : null;
        if (body.answers === undefined || stored === null) {
          throw new UnprocessableEntityException({ error: 'question_answers_required', message: 'AskUserQuestion needs answers to every question (answer in the dashboard/Telegram, or deny)' });
        }
        const check = validateAskAnswers(stored, body.answers);
        if (!check.ok) throw new UnprocessableEntityException({ error: 'invalid_answers', message: check.reason });
        answers = sanitizeAnswers(check.answers);
      }

      const outcome = decideApproval(
        { status: row.status, deadline: row.deadline, decidedByDeviceId: row.decided_by_device_id },
        { behavior: body.behavior, deviceId: actor.deviceId, now, lockdown },
      );

      if (outcome.kind === 'apply') {
        await m.query(
          `UPDATE approvals
              SET status = $2, decision_message = $3, decided_by_device_id = $4, decided_at = $5, resolved_at = $5, answers = $6::jsonb
            WHERE id = $1`,
          [id, outcome.status, body.message ?? null, actor.deviceId, now, answers === null ? null : JSON.stringify(answers)],
        );
        await this.audit.record(
          {
            actorDeviceId: actor.deviceId,
            actorKind: actor.actorKind,
            action: 'approval.decided',
            target: id,
            ip: actor.ip,
            details: {
              behavior: body.behavior,
              tool_name: row.tool_name,
              machine_id: row.machine_id,
              claude_session_id: row.claude_session_id,
              lockdown,
              has_message: body.message !== undefined,
              // Savol matnlari/javoblar auditga YOZILMAYDI (faqat soni va erkin matn ishlatilganmi).
              ...(answers !== null ? { question_count: answers.length, other_used: answers.some((a) => a.other !== undefined) } : {}),
            },
          },
          m,
        );
        await this.restoreSession(m, row.machine_id, row.claude_session_id, outcome.status);
      } else if (outcome.kind === 'expired') {
        await m.query(`UPDATE approvals SET status = 'expired', resolved_at = $2 WHERE id = $1`, [id, now]);
        await this.restoreSession(m, row.machine_id, row.claude_session_id, 'expired');
      }
      return { outcome, machineId: row.machine_id, claudeSessionId: row.claude_session_id, answers };
    });

    const { outcome, machineId, claudeSessionId, answers: decidedAnswers } = txResult;
    switch (outcome.kind) {
      case 'lockdown_allow_refused':
        throw new ForbiddenException({ error: 'lockdown', message: 'Lockdown is active: remote allow is refused (deny is permitted)' });
      case 'conflict':
        throw new ConflictException({ error: 'approval_conflict', message: `Approval already ${outcome.current}`, status: outcome.current });
      case 'expired':
        this.afterExpiry(machineId, claudeSessionId, id, now);
        throw new ConflictException({ error: 'approval_expired', message: 'Approval deadline has passed', status: 'expired' });
      case 'idempotent': {
        const dto = await this.getDto(id);
        return { approval: dto, delivered: dto.delivered === true, idempotent: true };
      }
      case 'apply': {
        const delivered = this.dispatch.send(machineId, 'approval.decision', {
          approvalId: id,
          behavior: body.behavior,
          ...(body.message !== undefined ? { message: body.message } : {}),
          ...(decidedAnswers !== null ? { answers: decidedAnswers } : {}),
          decidedAt: now.getTime(),
        });
        if (delivered) await this.dataSource.query(`UPDATE approvals SET delivered_at = now() WHERE id = $1`, [id]);
        this.bus.publish({ type: 'sessions.changed', refs: [{ machineId, claudeSessionId }] });
        this.bus.publish({ type: 'approval.resolved', approvalId: id });
        return { approval: await this.getDto(id), delivered, idempotent: false };
      }
    }
  }

  // --- muddat va qayta yetkazish ---------------------------------------------------------------

  /** Deadline'i o'tgan `pending` larni `expired` qiladi, agentga `approval.expired` yuboradi, klientlarga e'lon qiladi. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.cleanupPlans(now);
      const expired = await this.dataSource.transaction(async (m) => {
        const rows: Array<{ id: string; machine_id: string; claude_session_id: string }> = await m.query(
          `WITH upd AS (
             UPDATE approvals SET status = 'expired', resolved_at = $1
              WHERE status = 'pending' AND deadline <= $1
             RETURNING id, machine_id, claude_session_id
           ) SELECT id, machine_id, claude_session_id FROM upd`,
          [now],
        );
        for (const r of rows) await this.restoreSession(m, r.machine_id, r.claude_session_id, 'expired');
        return rows;
      });
      for (const r of expired) this.afterExpiry(r.machine_id, r.claude_session_id, r.id, now);
      return expired.length;
    } finally {
      this.sweeping = false;
    }
  }

  /** Reja matni retention'i (30 kun): matn NULL qilinadi, qator (holat, audit izi) qoladi. Soatiga bir marta. */
  private async cleanupPlans(now: Date): Promise<void> {
    if (now.getTime() - this.lastPlanCleanup < PLAN_CLEANUP_EVERY_MS) return;
    this.lastPlanCleanup = now.getTime();
    try {
      await this.dataSource.query(`UPDATE approvals SET plan_text = NULL WHERE plan_text IS NOT NULL AND requested_at < $1::timestamptz - make_interval(days => $2)`, [now, PLAN_RETENTION_DAYS]);
      await this.dataSource.query(`UPDATE approvals SET questions = NULL, answers = NULL WHERE questions IS NOT NULL AND requested_at < $1::timestamptz - make_interval(days => $2)`, [now, PLAN_RETENTION_DAYS]);
    } catch (err) {
      this.logger.error(`plan retention cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * agentd (qayta) ulanganda: qarori berilgan, lekin yetkazilmagan va deadline'i o'tmagan approval'larni qayta yuboradi.
   * Lockdown'da faqat `deny` yetkaziladi (`allow` ushlab turiladi: agent lokal promptga qaytadi).
   */
  async redeliver(machineId: string, now: Date = new Date()): Promise<number> {
    const lockdown = (await this.lockdown.state()).enabled;
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM approvals
        WHERE machine_id = $1 AND delivered_at IS NULL AND status IN ('approved', 'denied')
          AND deadline > $2 AND ($3::boolean = false OR status = 'denied')
        ORDER BY decided_at`,
      [machineId, now, lockdown],
    );
    let n = 0;
    for (const r of rows) if (await this.redeliverOne(machineId, r.id)) n += 1;
    return n;
  }

  // --- o'qish ----------------------------------------------------------------------------------

  async getDto(id: string): Promise<ApprovalDto> {
    const rows: ApprovalRow[] = await this.dataSource.query(`${SELECT_DTO} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Approval not found' });
    return toApprovalDto(rows[0]);
  }

  async list(q: ListApprovalsQuery): Promise<ListApprovalsResponse> {
    const machine = q.machine ?? null;
    const filter = `AND ($1::text IS NULL OR m.id::text = $1 OR m.slug = $1)`;
    const pending: ApprovalRow[] = await this.dataSource.query(`${SELECT_DTO} WHERE a.status = 'pending' ${filter} ORDER BY a.requested_at ASC LIMIT 200`, [machine]);
    const recent: ApprovalRow[] =
      q.recentLimit === 0
        ? []
        : await this.dataSource.query(`${SELECT_DTO} WHERE a.status <> 'pending' ${filter} ORDER BY a.resolved_at DESC, a.id LIMIT $2`, [machine, q.recentLimit]);
    // `recent` ro'yxatida reja matni yo'q (hajm: 16 KB x N); to'liq matn `GET /v1/approvals/:id` da.
    return { pending: pending.map(toApprovalDto), recent: recent.map((r) => ({ ...toApprovalDto(r), plan: null })) };
  }

  // --- ichki -----------------------------------------------------------------------------------

  /** Hal bo'lgan approval natijasini agentga yuboradi (decision yoki expired). `true`: yuborildi. */
  private async redeliverOne(machineId: string, id: string): Promise<boolean> {
    const rows: Array<{ status: ApprovalStatus; decision_message: string | null; decided_at: Date | null; resolved_at: Date | null; delivered_at: Date | null; answers: unknown }> =
      await this.dataSource.query(`SELECT status, decision_message, decided_at, resolved_at, delivered_at, answers FROM approvals WHERE id = $1 AND machine_id = $2`, [id, machineId]);
    const r = rows[0];
    if (!r || r.delivered_at !== null) return false;
    if (r.status === 'expired' && r.resolved_at) return this.dispatch.send(machineId, 'approval.expired', { approvalId: id, expiredAt: r.resolved_at.getTime() });
    if ((r.status === 'approved' || r.status === 'denied') && r.decided_at) {
      const ok = this.dispatch.send(machineId, 'approval.decision', {
        approvalId: id,
        behavior: (behaviorForStatus(r.status) as ApprovalBehavior),
        ...(r.decision_message !== null ? { message: r.decision_message } : {}),
        ...(r.status === 'approved' && parseJson(AskAnswersSchema, r.answers) ? { answers: parseJson(AskAnswersSchema, r.answers)! } : {}),
        decidedAt: r.decided_at.getTime(),
      });
      if (ok) await this.dataSource.query(`UPDATE approvals SET delivered_at = now() WHERE id = $1`, [id]);
      return ok;
    }
    return false;
  }

  /** Muddati o'tgandan keyingi umumiy ishlar (tranzaksiyadan tashqarida). */
  private afterExpiry(machineId: string, claudeSessionId: string, id: string, now: Date): void {
    this.dispatch.send(machineId, 'approval.expired', { approvalId: id, expiredAt: now.getTime() });
    this.bus.publish({ type: 'sessions.changed', refs: [{ machineId, claudeSessionId }] });
    this.bus.publish({ type: 'approval.resolved', approvalId: id });
  }

  /** Sessiyani `awaiting_approval` ga o'tkazadi (tugamagan bo'lsa); oldingi holatni qaytaradi (yo'q sessiya: null). */
  private async markSessionAwaiting(m: EntityManager, machineId: string, claudeSessionId: string): Promise<string | null> {
    const rows: Array<{ id: string; status: string }> = await m.query(
      `SELECT id, status FROM sessions WHERE machine_id = $1 AND claude_session_id = $2 AND ended_at IS NULL FOR UPDATE`,
      [machineId, claudeSessionId],
    );
    const s = rows[0];
    if (!s) return null;
    if (s.status !== 'awaiting_approval') {
      await m.query(`UPDATE sessions SET status = 'awaiting_approval', status_since = now() WHERE id = $1`, [s.id]);
    }
    return s.status;
  }

  /** Oxirgi pending yopilganda `awaiting_approval` ni tiklaydi (agent hodisalari uni baribir yangilaydi). */
  private async restoreSession(m: EntityManager, machineId: string, claudeSessionId: string, resolved: ApprovalStatus): Promise<void> {
    await m.query(
      `UPDATE sessions SET status = $3, status_since = now()
        WHERE machine_id = $1 AND claude_session_id = $2 AND status = 'awaiting_approval' AND ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.machine_id = $1 AND a.claude_session_id = $2 AND a.status = 'pending')`,
      [machineId, claudeSessionId, sessionStatusAfter(resolved)],
    );
  }
}
