import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { ORCH_LIMITS, ORCH_OPS, extractTaskMarker, renderDispatchPrompt, renderKickoffPrompt, STEP_ACTIVE_STATUSES } from '@commander/contracts';
import type {
  CancelOrchestrationResponse,
  OrchScope,
  CommandDto,
  CreateOrchestrationBody,
  ListOrchestrationsQuery,
  ListOrchestrationsResponse,
  MailboxCall,
  OrchConfirmation,
  OrchDispatchMode,
  OrchStatus,
  OrchTextResult,
  OrchestrationDto,
  OrchStepDto,
  StepStatus,
} from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { BudgetsService } from '../budgets/budgets.service.js';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { beforeStartHooks } from '../commands/before-start.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { MessagingError, MessagingService } from '../messaging/messaging.service.js';
import { guessRole, shortIdOf } from '../messaging/messaging-logic.js';
import { QueueService } from '../queue/queue.service.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { formatOrchNotice } from './orchestration-format.js';
import {
  OrchError,
  checkDispatch,
  checkStepUpdate,
  countSteps,
  buildScope,
  checkScope,
  cwdWithinProjects,
  deriveStatus,
  formatScopeLines,
  SCOPE_MISS_TEXT,
  formatStatusText,
  pickCandidate,
  stepKeyMatches,
  validatePlan,
} from './orchestration-logic.js';
import type { Candidate, OrchNoticeKind } from './orchestration-logic.js';
import { ORCH_OPTIONS } from './orchestration.options.js';
import type { OrchOptions } from './orchestration.options.js';
import { OrchestrationNotifier } from './orchestration-notifier.js';

type OrchOrigin = 'dashboard' | 'telegram' | 'lead';

export interface OrchActor {
  deviceId: string;
  actorKind: AuditActorKind;
  ip: string | null;
}

interface OrchRow {
  id: string;
  goal: string;
  group_key: string;
  status: OrchStatus;
  origin: OrchOrigin;
  task_key: string | null;
  project_id: string | null;
  lead_session_id: string | null;
  lead_machine_id: string | null;
  lead_command_id: string | null;
  confirmation: OrchConfirmation | null;
  confirmed_at: Date | null;
  confirmed_by_device_id: string | null;
  created_by_device_id: string | null;
  /** H-05: tasdiq qamrovi; NULL = hech narsa qoplanmaydi. */
  scope: OrchScope | null;
  new_sessions_used: number;
  confirmed_targets: string[];
  token_budget: string;
  max_concurrent: number;
  budget_exceeded_at: Date | null;
  cancel_reason: string | null;
  notified_status: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  lead_label: string | null;
}

interface StepRow {
  id: string;
  orchestration_id: string;
  key: string;
  position: number;
  title: string;
  role: string;
  machine: string | null;
  cwd: string | null;
  depends_on: string[];
  status: StepStatus;
  assigned_session_id: string | null;
  assigned_label: string | null;
  dispatch_mode: OrchDispatchMode | null;
  dispatch_seq: number;
  dispatch_command_id: string | null;
  queue_item_id: string | null;
  result_summary: string | null;
  last_error: string | null;
  dispatched_at: Date | null;
  finished_at: Date | null;
}

interface CallerCtx {
  sessionId: string;
  machineId: string;
  claudeSessionId: string;
  projectId: string | null;
  groupKey: string | null;
  kind: string;
  status: string;
  cwd: string;
  machineName: string;
}

const GROUP_EXPR = `COALESCE('workspace:' || l.workspace, COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text))`;
const BASE_EXPR = `COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text)`;
const SESSION_LABEL = `(SELECT COALESCE(m.display_name, m.hostname, m.slug) || '/' || left(s.claude_session_id, 8) FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.id = %ID%)`;

const SELECT_ORCH = `SELECT o.*, ${SESSION_LABEL.replace('%ID%', 'o.lead_session_id')} AS lead_label FROM orchestrations o`;
const SELECT_STEPS = `SELECT t.*, ${SESSION_LABEL.replace('%ID%', 't.assigned_session_id')} AS assigned_label FROM orchestration_steps t`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ACTIVE_ORCH = `('planning', 'running', 'failed')`;
const CMD_FAILED = new Set(['failed', 'expired', 'rejected']);
/** `bg` sessiya keyingi prompt'da qayta ochiladi (SessionEnd -> resume): shuncha soniya tugagan holatda qolsagina ishchi "yo'qolgan" hisoblanadi. */
const SESSION_END_GRACE_S = 120;

/** `OrchError` -> agentga `MessagingError` (kod `orch_*` ro'yxatda). */
function asMessagingError(err: OrchError): MessagingError {
  return new MessagingError(err.code, err.message);
}

/**
 * Orkestratsiya (3.9). Xavfsizlik invariantlari (testlar tekshiradi):
 *  - lead/ishchi identifikatsiyasi `CLAUDE_CODE_SESSION_ID` -> markaz sessiyasi (agentd mashinasi bo'yicha); qadamni faqat unga
 *    tayinlangan sessiya yoki lead yangilaydi; dispatch faqat lead'dan va faqat o'z orkestratsiyasida;
 *  - dispatch guruh doirasida: mavjud sessiya = guruh a'zosi (`bg`, bo'sh, band emas); yangi sessiya/navbat = guruh loyihasi ichidagi cwd;
 *  - hamma masofaviy amal `CommandsService` (yoki `QueueService`) orqali: siyosat/step-up/audit konveyeri o'zgarmaydi; audit dispatchdan OLDIN;
 *  - egasi tasdig'i (istisno qurilma / Telegram) orkestratsiyada yoziladi va shu orkestratsiya dispatch'larini qoplaydi (bir marta);
 *    tasdiqsiz (lead yaratgan) orkestratsiyada yangi sessiya ochish oddiy Telegram step-up talab qiladi, tasdiqdan keyin qoplanadi;
 *  - tashqi cheklovlar: <= 20 qadam, parallel <= maxConcurrent, token byudjeti, bog'liqlik tartibi, lockdown dispatch'ni bloklaydi;
 *  - "To'xtatish" hamma ishtirokchi sessiyaga `session.stop` yuboradi va orkestratsiyani `cancelled` qiladi (lockdown'da ham ruxsat).
 */
@Injectable()
export class OrchestrationService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(OrchestrationService.name);
  private readonly limiter = new FixedWindowLimiter(ORCH_LIMITS.callLimit, ORCH_LIMITS.callWindowMs);
  private unsubscribers: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    private readonly commands: CommandsService,
    private readonly queue: QueueService,
    private readonly lockdown: LockdownService,
    private readonly dispatchSvc: AgentDispatchService,
    private readonly messaging: MessagingService,
    @Inject(ORCH_OPTIONS) private readonly options: OrchOptions,
    @Optional() private readonly notifier?: OrchestrationNotifier,
    /** 6.11: kunlik byudjet (mavjud sessiyaga topshirish; yangi sessiya/navbat `commands.create`/scheduler orqali tekshiriladi). */
    @Optional() private readonly budgets?: BudgetsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.messaging.registerCallExtension({
        ops: new Set<string>(ORCH_OPS),
        handle: (machineId, deviceId, claudeSessionId, call) => this.handleCall(machineId, deviceId, claudeSessionId, call),
      }),
    );
    this.unsubscribers.push(
      this.bus.subscribe((e) => {
        if (e.type === 'command.changed') return this.onCommandChanged(e.commandId);
        if (e.type === 'queue.changed') return this.onQueueChanged(e.queueId);
        if (e.type === 'device.event' && e.kind === 'revoked' && e.deviceId) return void this.cancelForRevokedDevice(e.deviceId).catch((err: unknown) => this.logger.error(`cancel on device revoke failed: ${errMsg(err)}`));
        return undefined;
      }),
    );
    if (this.options.tickMs > 0) {
      this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`orchestration tick failed: ${errMsg(err)}`)), this.options.tickMs);
      this.timer.unref();
    }
  }

  beforeApplicationShutdown(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- agent so'rovlari (cc-mcp -> agentd -> center) ----------------------------------------------

  async handleCall(machineId: string, deviceId: string, claudeSessionId: string, call: MailboxCall): Promise<OrchTextResult> {
    try {
      const ctx = await this.callerCtx(machineId, claudeSessionId);
      if (!ctx) throw new OrchError('orch_not_found', "Center bu sessiyani hali bilmaydi (birinchi hook hodisasi kelgach urinib ko'ring)");
      if (this.limiter.hit(`orch:${ctx.sessionId}`) > ORCH_LIMITS.callLimit) throw new OrchError('orch_limit', 'Juda tez-tez chaqiruv: bir daqiqada eng ko\'pi 60 ta');
      switch (call.op) {
        case 'orch_plan':
          return await this.planCreate(ctx, deviceId, call.goal, call.steps);
        case 'orch_dispatch':
          return await this.dispatch(ctx, deviceId, call);
        case 'orch_step_update':
          return await this.stepUpdate(ctx, deviceId, call.stepId, call.status, call.summary);
        case 'orch_status':
          return await this.statusFor(ctx);
        default:
          throw new OrchError('orch_invalid', `Noma'lum operatsiya: ${call.op}`);
      }
    } catch (err) {
      if (err instanceof OrchError) throw asMessagingError(err);
      throw err;
    }
  }

  private async callerCtx(machineId: string, claudeSessionId: string): Promise<CallerCtx | null> {
    const rows: Array<{ id: string; machine_id: string; claude_session_id: string; project_id: string | null; group_key: string | null; kind: string; status: string; cwd: string; machine_name: string; ended_at: Date | null }> =
      await this.dataSource.query(
        `SELECT s.id, s.machine_id, s.claude_session_id, s.project_id, s.kind, s.status, s.cwd, s.ended_at,
                COALESCE(m.display_name, m.hostname, m.slug) AS machine_name,
                CASE WHEN p.id IS NULL THEN NULL ELSE ${GROUP_EXPR} END AS group_key
           FROM sessions s
           JOIN machines m ON m.id = s.machine_id
           LEFT JOIN projects p ON p.id = s.project_id
           LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR}
          WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
        [machineId, claudeSessionId],
      );
    const r = rows[0];
    if (!r || r.ended_at !== null) return null;
    return { sessionId: r.id, machineId: r.machine_id, claudeSessionId: r.claude_session_id, projectId: r.project_id, groupKey: r.group_key, kind: r.kind, status: r.status, cwd: r.cwd, machineName: r.machine_name };
  }

  private async messagingEnabled(groupKey: string): Promise<boolean> {
    const g: Array<{ value: { enabled?: unknown } }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'messaging.enabled'`);
    if (g[0]?.value?.enabled === false) return false;
    const rows: Array<{ enabled: boolean }> = await this.dataSource.query(`SELECT enabled FROM messaging_groups WHERE group_key = $1`, [groupKey]);
    return rows[0]?.enabled === true;
  }

  // --- reja ---------------------------------------------------------------------------------------

  private async planCreate(ctx: CallerCtx, deviceId: string, goal: string, stepsIn: Parameters<typeof validatePlan>[0]): Promise<OrchTextResult> {
    if (!ctx.groupKey) throw new OrchError('orch_invalid', "Bu sessiya loyihaga bog'lanmagan (guruh yo'q)");
    const planned = validatePlan(stepsIn);
    const id = await this.dataSource.transaction(async (m): Promise<string> => {
      // lead'ning ochiq orkestratsiyasi: planning bo'lsa to'ldiramiz; boshqasi faol bo'lsa rad
      const open: Array<{ id: string; status: OrchStatus }> = await m.query(
        `SELECT id, status FROM orchestrations WHERE lead_session_id = $1 AND status IN ${ACTIVE_ORCH} ORDER BY created_at DESC FOR UPDATE`,
        [ctx.sessionId],
      );
      const planning = open.find((o) => o.status === 'planning');
      if (!planning && open.length > 0) throw new OrchError('orch_conflict', 'Sizning faol orkestratsiyangiz bor: avval uni tugating yoki egasi to\'xtatsin');
      let orchId: string;
      let origin: OrchOrigin;
      if (planning) {
        orchId = planning.id;
        origin = 'dashboard';
        const cnt: Array<{ n: number }> = await m.query(`SELECT count(*)::int AS n FROM orchestration_steps WHERE orchestration_id = $1`, [orchId]);
        if ((cnt[0]?.n ?? 0) > 0) throw new OrchError('orch_conflict', 'Reja allaqachon tuzilgan');
      } else {
        if (!(await this.messagingEnabled(ctx.groupKey as string))) {
          throw new OrchError('orch_blocked', "Bu guruhda sessiyalararo aloqa o'chiq: egasi dashboard'dan yoqmaguncha sessiya o'zi orkestratsiya boshlay olmaydi");
        }
        const ins: Array<{ id: string }> = await m.query(
          `INSERT INTO orchestrations (goal, group_key, status, origin, project_id, lead_session_id, lead_machine_id, token_budget, max_concurrent)
           VALUES ($1, $2, 'planning', 'lead', $3, $4, $5, $6, $7) RETURNING id`,
          [redactAndCap(goal, ORCH_LIMITS.goalMaxChars), ctx.groupKey, ctx.projectId, ctx.sessionId, ctx.machineId, ORCH_LIMITS.defaultTokenBudget, ORCH_LIMITS.defaultMaxConcurrent],
        );
        orchId = ins[0]?.id as string;
        origin = 'lead';
        await this.audit.record({ actorDeviceId: deviceId, actorKind: 'agentd', action: 'orchestration.created', target: orchId, details: { origin: 'lead', group_key: ctx.groupKey, lead_session_id: ctx.sessionId, goal_length: goal.length } }, m);
      }
      for (const p of planned) {
        await m.query(
          `INSERT INTO orchestration_steps (orchestration_id, key, position, title, role, machine, cwd, depends_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`,
          [orchId, p.key, p.position, redactAndCap(p.title, ORCH_LIMITS.titleMaxChars), p.role, p.machine, p.cwd, p.dependsOn],
        );
      }
      await m.query(`UPDATE orchestrations SET status = 'running', updated_at = now() WHERE id = $1`, [orchId]);
      await this.audit.record(
        { actorDeviceId: deviceId, actorKind: 'agentd', action: 'orchestration.plan_created', target: orchId, details: { origin, steps: planned.length, roles: [...new Set(planned.map((p) => p.role))], lead_session_id: ctx.sessionId } },
        m,
      );
      return orchId;
    });
    const dto = await this.changed(id);
    void this.notify('started', dto);
    return { text: `Reja qabul qilindi: ${planned.length} ta qadam.\n${formatStatusText(dto)}` };
  }

  // --- dispatch -----------------------------------------------------------------------------------

  private async dispatch(ctx: CallerCtx, deviceId: string, call: Extract<MailboxCall, { op: 'orch_dispatch' }>): Promise<OrchTextResult> {
    const orch = await this.activeOrchOfLead(ctx.sessionId);
    if (!orch) {
      const last: Array<{ status: OrchStatus }> = await this.dataSource.query(`SELECT status FROM orchestrations WHERE lead_session_id = $1 ORDER BY created_at DESC LIMIT 1`, [ctx.sessionId]);
      if (last[0]?.status === 'cancelled') throw new OrchError('orch_blocked', "Orkestratsiya to'xtatilgan");
      if (last[0]?.status === 'completed') throw new OrchError('orch_blocked', 'Orkestratsiya tugagan');
      const asWorker = await this.dataSource.query(`SELECT 1 FROM orchestration_steps WHERE assigned_session_id = $1 LIMIT 1`, [ctx.sessionId]);
      if (asWorker.length > 0) throw new OrchError('orch_forbidden', 'Faqat bosh sessiya (lead) qadam topshira oladi');
      throw new OrchError('orch_not_found', "Sizda faol orkestratsiya yo'q (commander_plan_create)");
    }
    const lockdownOn = (await this.lockdown.state()).enabled;

    interface Plan {
      step: StepRow;
      mode: OrchDispatchMode;
      targetSessionId: string | null;
      targetClaude: string | null;
      machineId: string | null;
      cwd: string | null;
      seq: number;
      confirmed: boolean;
      confirmation: OrchConfirmation | null;
      /** H-05: existing_session nishoni birinchi marta: egasi tasdig'i (step-up) majburiy. */
      forceStepUp: boolean;
      /** H-05: tasdiq qamroviga kirmadi (sabab); dispatch yangi Telegram tasdig'ini talab qiladi. */
      scopeMiss: string | null;
      countedNewSession: boolean;
      permissionMode: 'default' | 'acceptEdits' | 'plan';
      taskKey: string | null;
      goal: string;
      orchId: string;
    }
    const plan = await this.dataSource.transaction(async (m): Promise<Plan> => {
      const locked: OrchRow[] = await m.query(`${SELECT_ORCH} WHERE o.id = $1 FOR UPDATE OF o`, [orch.id]);
      const o = locked[0];
      if (!o) throw new OrchError('orch_not_found', 'Orkestratsiya topilmadi');
      const steps = await this.stepRows(o.id, m);
      const step = steps.find((s) => stepKeyMatches({ id: s.id, key: s.key }, call.stepId));
      if (!step) throw new OrchError('orch_not_found', `Qadam topilmadi: "${call.stepId.slice(0, 40)}" (commander_orchestration_status)`);
      const used = await this.tokensUsed(o, steps, m);
      checkDispatch({
        orchestrationStatus: o.status,
        lockdown: lockdownOn,
        step: { key: step.key, status: step.status, dependsOn: step.depends_on },
        allSteps: steps.map((s) => ({ key: s.key, status: s.status, dependsOn: s.depends_on })),
        maxConcurrent: o.max_concurrent,
        tokensUsed: used,
        tokenBudget: Number(o.token_budget),
        budgetExceededFlag: o.budget_exceeded_at !== null,
      });

      const permissionMode = call.permissionMode ?? 'default';
      let targetSessionId: string | null = null;
      let targetClaude: string | null = null;
      let machineId: string | null = null;
      let cwd: string | null = null;
      if (call.mode === 'existing_session') {
        const cands = await this.candidates(o, m);
        const pick = pickCandidate(cands, { session: call.session, role: call.role ?? step.role });
        targetSessionId = pick.sessionId;
        targetClaude = pick.claudeSessionId;
        machineId = pick.machineId;
      } else {
        const ref = call.machine ?? step.machine;
        machineId = ref ? await this.resolveMachine(ref, m) : (o.lead_machine_id ?? ctx.machineId);
        cwd = call.cwd ?? step.cwd;
        if (!cwd) throw new OrchError('orch_invalid', 'cwd kerak (dispatch yoki reja qadamida)');
        const paths: Array<{ path: string }> = await m.query(
          `SELECT p.path FROM projects p LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR} WHERE p.machine_id = $1 AND ${GROUP_EXPR} = $2`,
          [machineId, o.group_key],
        );
        if (!cwdWithinProjects(cwd, paths.map((p) => p.path))) {
          throw new OrchError('orch_blocked', `cwd bu guruhning loyiha papkalaridan biri ichida bo'lishi shart (${cwd.slice(0, 80)})`);
        }
      }

      // H-05: tasdiq qamrovi. new_session/queue: faqat qamrov ichida tasdiqsiz; tashqarisi yangi step-up (queue: rad).
      // existing_session: guruhda aloqa yoqilgan bo'lishi shart va har bir nishon sessiya uchun birinchi marta egasi tasdig'i.
      let covered = false;
      let scopeMiss: string | null = null;
      let forceStepUp = false;
      let countedNewSession = false;
      if (call.mode === 'existing_session') {
        if (!(await this.messagingEnabled(o.group_key))) {
          throw new OrchError('orch_blocked', "Bu guruhda sessiyalararo aloqa o'chiq: mavjud sessiyaga topshirib bo'lmaydi (egasi dashboard'dan yoqishi kerak)");
        }
        forceStepUp = targetSessionId !== null && !(o.confirmed_targets ?? []).includes(targetSessionId);
      } else {
        const confirmer: Array<{ revoked_at: Date | null }> = o.confirmed_by_device_id ? await m.query(`SELECT revoked_at FROM devices WHERE id = $1`, [o.confirmed_by_device_id]) : [];
        const confirmerRevoked = confirmer[0]?.revoked_at != null;
        const sc = checkScope(o.scope, { confirmed: o.confirmed_at !== null && !confirmerRevoked, machineId: machineId as string, cwd: cwd as string, permissionMode, newSessionsUsed: o.new_sessions_used ?? 0 });
        covered = sc.covered;
        scopeMiss = sc.covered ? null : sc.reason;
        if (covered) {
          await m.query(`UPDATE orchestrations SET new_sessions_used = new_sessions_used + 1 WHERE id = $1`, [o.id]);
          countedNewSession = true;
        }
      }

      const seq = step.dispatch_seq + 1;
      await m.query(
        `UPDATE orchestration_steps SET status = 'dispatched', dispatch_mode = $2, dispatch_seq = $3, assigned_session_id = $4, dispatch_command_id = NULL, queue_item_id = NULL,
                last_error = NULL, result_summary = NULL, dispatched_at = now(), finished_at = NULL, updated_at = now() WHERE id = $1`,
        [step.id, call.mode, seq, targetSessionId],
      );
      const nextStatus = deriveStatus(o.status, steps.map((s) => (s.id === step.id ? { status: 'dispatched' as StepStatus } : s)));
      await m.query(`UPDATE orchestrations SET status = $2, updated_at = now(), finished_at = NULL WHERE id = $1`, [o.id, nextStatus]);
      await this.audit.record(
        {
          actorDeviceId: deviceId,
          actorKind: 'agentd',
          action: 'orchestration.dispatch',
          target: o.id,
          details: {
            step_id: step.id,
            step_key: step.key,
            mode: call.mode,
            seq,
            lead_session_id: ctx.sessionId,
            ...(targetSessionId ? { target_session_id: targetSessionId } : {}),
            ...(machineId ? { machine_id: machineId } : {}),
            ...(cwd ? { cwd } : {}),
            permission_mode: permissionMode,
            prompt_length: call.prompt.length,
            orchestration_confirmed: o.confirmed_at !== null,
            confirmation: o.confirmation,
            scope_covered: covered,
            ...(scopeMiss ? { scope_miss: scopeMiss } : {}),
            ...(forceStepUp ? { target_needs_confirmation: true } : {}),
          },
        },
        m,
      );
      return { step, mode: call.mode, targetSessionId, targetClaude, machineId, cwd, seq, confirmed: covered, confirmation: o.confirmation, forceStepUp, scopeMiss, countedNewSession, permissionMode, taskKey: o.task_key, goal: o.goal, orchId: o.id };
    });
    void this.changed(plan.orchId);

    // --- buyruqni yaratish (tranzaksiyadan KEYIN; audit allaqachon yozilgan) ---
    const body = redactAndCap(call.prompt, ORCH_LIMITS.promptMaxChars);
    const stepTask = extractTaskMarker(`#task:${plan.step.key}`) === plan.step.key.toLowerCase() ? plan.step.key : plan.taskKey;
    const text = renderDispatchPrompt({
      orchestrationId: plan.orchId,
      stepId: plan.step.id,
      stepKey: plan.step.key,
      title: plan.step.title,
      role: plan.step.role,
      goal: plan.goal,
      taskKey: stepTask,
      leadShortId: shortIdOf(ctx.claudeSessionId),
      body,
    });
    const key = `orch-${plan.step.id.slice(0, 8)}-${plan.seq}`;
    const actor: CommandActor = {
      deviceId,
      actorKind: 'system',
      ip: null,
      ...(plan.confirmed ? { confirmation: 'orchestration' as const } : {}),
      ...(plan.forceStepUp ? { forceStepUp: true } : {}),
      ...(plan.scopeMiss && plan.mode !== 'existing_session' ? { reviewNotes: [`Orkestratsiya tasdig'i bu topshiriqni qoplamaydi: ${SCOPE_MISS_TEXT[plan.scopeMiss as keyof typeof SCOPE_MISS_TEXT] ?? plan.scopeMiss}`] } : {}),
      ...(plan.forceStepUp ? { reviewNotes: ['Orkestratsiya mavjud sessiyaga prompt yubormoqchi (bu nishon uchun birinchi marta): tasdiqlaysizmi?'] } : {}),
    };
    let outcome: { commandId: string | null; queueItemId: string | null; waiting: boolean; failure: string | null };
    try {
      outcome = await this.fire(plan, text, key, actor, call, ctx);
    } catch (err) {
      outcome = { commandId: null, queueItemId: null, waiting: false, failure: this.failureCode(err) };
    }
    if (outcome.failure) {
      await this.revertDispatch(plan.step.id, plan.orchId, plan.seq, outcome.failure, deviceId, plan.countedNewSession);
      throw new OrchError(outcome.failure === 'lockdown' ? 'orch_blocked' : 'orch_conflict', `Topshirib bo'lmadi: ${outcome.failure}`);
    }
    await this.dataSource.query(`UPDATE orchestration_steps SET dispatch_command_id = $2, queue_item_id = $3, updated_at = now() WHERE id = $1 AND dispatch_seq = $4`, [plan.step.id, outcome.commandId, outcome.queueItemId, plan.seq]);
    const dto = await this.changed(plan.orchId);
    const where = plan.mode === 'existing_session' ? `mavjud sessiya ${shortIdOf(plan.targetClaude ?? '')}` : plan.mode === 'new_session' ? 'yangi sessiya' : 'navbat';
    const note = outcome.waiting ? " Egasining Telegram tasdig'i kutilmoqda (yangi sessiya)." : '';
    return { text: `Qadam "${plan.step.key}" topshirildi (${where}).${note} Ishchi commander_step_update bilan hisobot beradi.\n${formatStatusText(dto, plan.step.id)}` };
  }

  private async fire(
    plan: { step: StepRow; mode: OrchDispatchMode; targetSessionId: string | null; machineId: string | null; cwd: string | null; confirmation: OrchConfirmation | null; confirmed: boolean; permissionMode: 'default' | 'acceptEdits' | 'plan'; orchId: string },
    text: string,
    key: string,
    actor: CommandActor,
    call: Extract<MailboxCall, { op: 'orch_dispatch' }>,
    ctx: CallerCtx,
  ): Promise<{ commandId: string | null; queueItemId: string | null; waiting: boolean; failure: string | null }> {
    if (plan.mode === 'existing_session') {
      // 6.11: qattiq byudjet chegarasida mavjud sessiyaga ham yangi ish topshirilmaydi (`budget_exceeded`)
      if (this.budgets && (await this.budgets.checkSession(plan.targetSessionId as string).catch(() => null))) return { commandId: null, queueItemId: null, waiting: false, failure: 'budget_exceeded' };
      const res = await this.commands.create({ type: 'session.prompt', sessionId: plan.targetSessionId as string, text }, actor, key);
      return this.fromCommand(res.command);
    }
    if (plan.mode === 'new_session') {
      const name = `orch ${plan.orchId.slice(0, 6)} ${plan.step.key}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 59);
      // 6.9: avto-checkpoint (sozlama yoqilgan bo'lsa; best-effort, dispatch'ni to'xtatmaydi)
      await beforeStartHooks.run({ kind: 'orchestration', machineId: plan.machineId as string, cwd: plan.cwd as string, label: name }, actor);
      const res = await this.commands.create(
        { type: 'session.start', machineId: plan.machineId as string, cwd: plan.cwd as string, prompt: text, permissionMode: plan.permissionMode, ...(call.model ? { model: call.model } : {}), name },
        actor,
        key,
      );
      return this.fromCommand(res.command);
    }
    // queue: faqat tasdiqlangan orkestratsiyada (navbat elementi yaratish step-up talab qiladi; egasi tasdig'i qoplaydi)
    if (!plan.confirmation || !plan.confirmed) {
      return { commandId: null, queueItemId: null, waiting: false, failure: 'confirmation_required' };
    }
    const when = call.when ?? 'machine_idle';
    const item = await this.queue.create(
      {
        machineId: plan.machineId as string,
        cwd: plan.cwd as string,
        prompt: text,
        permissionMode: plan.permissionMode,
        name: `orch ${plan.orchId.slice(0, 6)} ${plan.step.key}`.replace(/[^A-Za-z0-9 ._-]/g, '-').slice(0, 59),
        trigger: when === 'limit_reset' ? { type: 'limit_reset', window: '5h' } : when === 'now' ? { type: 'now' } : { type: 'machine_idle' },
        ...(call.model ? { model: call.model } : {}),
      },
      { deviceId: actor.deviceId, actorKind: 'system', ip: null, orchestrationConfirmation: plan.confirmation === 'exempt_device' ? 'exempt_device' : 'telegram_inline' },
    );
    void ctx;
    return { commandId: null, queueItemId: item.id, waiting: false, failure: null };
  }

  private fromCommand(c: CommandDto): { commandId: string; queueItemId: null; waiting: boolean; failure: string | null } {
    if (c.status === 'rejected' || c.status === 'failed' || c.status === 'expired') return { commandId: c.id, queueItemId: null, waiting: false, failure: c.errorCode ?? c.status };
    return { commandId: c.id, queueItemId: null, waiting: c.status === 'awaiting_confirmation', failure: null };
  }

  private failureCode(err: unknown): string {
    if (err instanceof HttpException) {
      const r = err.getResponse();
      const obj = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {};
      return typeof obj['error'] === 'string' ? obj['error'] : `http_${err.getStatus()}`;
    }
    this.logger.error(`orchestration dispatch failed: ${errMsg(err)}`);
    return 'internal_error';
  }

  /** Buyruq yaratilmadi: qadam `pending`ga qaytadi (urinish `dispatch_seq`da qoladi), sabab yoziladi va audit qilinadi. */
  private async revertDispatch(stepId: string, orchId: string, seq: number, code: string, deviceId: string, countedNewSession = false): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      if (countedNewSession) await m.query(`UPDATE orchestrations SET new_sessions_used = GREATEST(0, new_sessions_used - 1) WHERE id = $1`, [orchId]);
      await m.query(
        `UPDATE orchestration_steps SET status = 'pending', assigned_session_id = NULL, dispatch_mode = NULL, last_error = $2, updated_at = now() WHERE id = $1 AND dispatch_seq = $3 AND status = 'dispatched'`,
        [stepId, code, seq],
      );
      await this.audit.record({ actorDeviceId: deviceId, actorKind: 'agentd', action: 'orchestration.dispatch_failed', target: orchId, details: { step_id: stepId, seq, reason: code } }, m);
      await this.recompute(orchId, m);
    });
    await this.changed(orchId);
  }

  // --- qadam yangilash ----------------------------------------------------------------------------

  private async stepUpdate(ctx: CallerCtx, deviceId: string, ref: string, status: 'in_progress' | 'done' | 'failed', summary: string | undefined): Promise<OrchTextResult> {
    await this.lazyAssign(ctx.sessionId);
    // Ruxsat doirasi: o'zi lead bo'lgan orkestratsiya qadamlari + o'ziga tayinlangan qadamlar
    const rows: Array<StepRow & { lead_session_id: string | null; orch_status: OrchStatus }> = await this.dataSource.query(
      `${SELECT_STEPS.replace('SELECT t.*,', 'SELECT t.*, o.lead_session_id, o.status AS orch_status,')} JOIN orchestrations o ON o.id = t.orchestration_id
        WHERE (t.assigned_session_id = $1 OR o.lead_session_id = $1) AND o.status IN ('running', 'failed', 'planning', 'completed', 'cancelled')
        ORDER BY o.created_at DESC, t.position`,
      [ctx.sessionId],
    );
    const hits = rows.filter((r) => stepKeyMatches({ id: r.id, key: r.key }, ref));
    // Bir nechta orkestratsiyada bir xil key bo'lishi mumkin: faol bo'lganini afzal ko'ramiz
    const active = hits.filter((h) => h.orch_status === 'running' || h.orch_status === 'failed');
    const pool = active.length > 0 ? active : hits;
    if (pool.length === 0) {
      const exists: unknown[] = await this.dataSource.query(`SELECT 1 FROM orchestration_steps WHERE id::text = $1 OR (length($1) >= 8 AND id::text LIKE $1 || '%')`, [ref.toLowerCase()]);
      if (exists.length > 0) throw new OrchError('orch_forbidden', "Bu qadamni faqat unga tayinlangan sessiya yoki bosh sessiya yangilay oladi");
      throw new OrchError('orch_not_found', `Qadam topilmadi: "${ref.slice(0, 40)}"`);
    }
    if (pool.length > 1) throw new OrchError('orch_invalid', "Qadam noaniq: to'liq id'ni yozing (commander_orchestration_status)");
    const hit = pool[0] as StepRow & { lead_session_id: string | null; orch_status: OrchStatus };
    const summaryText = summary !== undefined ? redactAndCap(summary, ORCH_LIMITS.summaryMaxChars) : null;

    const result = await this.dataSource.transaction(async (m) => {
      const lockedO: OrchRow[] = await m.query(`${SELECT_ORCH} WHERE o.id = $1 FOR UPDATE OF o`, [hit.orchestration_id]);
      const o = lockedO[0] as OrchRow;
      const cur: StepRow[] = await m.query(`${SELECT_STEPS} WHERE t.id = $1 FOR UPDATE OF t`, [hit.id]);
      const step = cur[0] as StepRow;
      const next = checkStepUpdate({
        callerSessionId: ctx.sessionId,
        leadSessionId: o.lead_session_id,
        assignedSessionId: step.assigned_session_id,
        orchestrationStatus: o.status,
        stepStatus: step.status,
        newStatus: status,
      });
      const terminal = next === 'done' || next === 'failed';
      await m.query(
        `UPDATE orchestration_steps SET status = $2, result_summary = COALESCE($3, result_summary), last_error = CASE WHEN $2 = 'failed' THEN COALESCE($3, 'failed') ELSE NULL END,
                finished_at = CASE WHEN $4::boolean THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
        [step.id, next, summaryText, terminal],
      );
      await this.audit.record(
        {
          actorDeviceId: deviceId,
          actorKind: 'agentd',
          action: 'orchestration.step_update',
          target: o.id,
          details: { step_id: step.id, step_key: step.key, from: step.status, to: next, caller_session_id: ctx.sessionId, is_lead: o.lead_session_id === ctx.sessionId, summary_length: summaryText?.length ?? 0 },
        },
        m,
      );
      const after = await this.recompute(o.id, m);
      return { next, after, stepId: step.id, stepKey: step.key, prev: o.status };
    });
    const dto = await this.changed(hit.orchestration_id);
    if (result.after !== result.prev && (result.after === 'completed' || result.after === 'failed')) void this.notify(result.after, dto);
    void this.checkBudget(hit.orchestration_id);
    return { text: `Qadam "${result.stepKey}" -> ${result.next}.\n${formatStatusText(dto, result.stepId)}` };
  }

  private async statusFor(ctx: CallerCtx): Promise<OrchTextResult> {
    await this.lazyAssign(ctx.sessionId);
    const led: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM orchestrations WHERE lead_session_id = $1 ORDER BY (status IN ${ACTIVE_ORCH}) DESC, created_at DESC LIMIT 1`,
      [ctx.sessionId],
    );
    let id = led[0]?.id ?? null;
    let viewerStep: string | undefined;
    if (!id) {
      const asW: Array<{ orchestration_id: string; id: string }> = await this.dataSource.query(
        `SELECT t.orchestration_id, t.id FROM orchestration_steps t JOIN orchestrations o ON o.id = t.orchestration_id WHERE t.assigned_session_id = $1 ORDER BY (o.status IN ${ACTIVE_ORCH}) DESC, t.dispatched_at DESC NULLS LAST LIMIT 1`,
        [ctx.sessionId],
      );
      id = asW[0]?.orchestration_id ?? null;
      viewerStep = asW[0]?.id;
    }
    if (!id) throw new OrchError('orch_not_found', "Siz hech bir orkestratsiyada qatnashmaysiz");
    return { text: formatStatusText(await this.getDto(id), viewerStep) };
  }

  private async activeOrchOfLead(sessionId: string): Promise<{ id: string } | null> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM orchestrations WHERE lead_session_id = $1 AND status IN ${ACTIVE_ORCH} ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    return rows[0] ?? null;
  }

  // --- yordamchilar -------------------------------------------------------------------------------

  private async stepRows(orchId: string, m: EntityManager | DataSource = this.dataSource): Promise<StepRow[]> {
    return m.query(`${SELECT_STEPS} WHERE t.orchestration_id = $1 ORDER BY t.position`, [orchId]);
  }

  private async resolveMachine(ref: string, m: EntityManager): Promise<string> {
    const rows: Array<{ id: string }> = await m.query(
      `SELECT id FROM machines WHERE status = 'active' AND merged_into_id IS NULL AND (lower(slug) = lower($1) OR lower(hostname) = lower($1) OR lower(display_name) = lower($1)) LIMIT 2`,
      [ref],
    );
    if (rows.length === 0) throw new OrchError('orch_invalid', `Mashina topilmadi: "${ref.slice(0, 60)}"`);
    if (rows.length > 1) throw new OrchError('orch_invalid', `Mashina nomi noaniq: "${ref.slice(0, 60)}"`);
    return (rows[0] as { id: string }).id;
  }

  private async candidates(o: OrchRow, m: EntityManager): Promise<Candidate[]> {
    const rows: Array<{ id: string; claude_session_id: string; machine_id: string; kind: string; status: string; role: string | null; project_name: string; project_path: string | null; cwd: string; busy: boolean }> = await m.query(
      `SELECT s.id, s.claude_session_id, s.machine_id, s.kind, s.status, s.cwd, r.role,
              COALESCE(p.name, s.project) AS project_name, p.path AS project_path,
              EXISTS (SELECT 1 FROM orchestration_steps t WHERE t.assigned_session_id = s.id AND t.status IN ('dispatched', 'running')) AS busy
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR}
         LEFT JOIN session_roles r ON r.session_id = s.id
        WHERE s.ended_at IS NULL AND s.status <> 'ended' AND ${GROUP_EXPR} = $1`,
      [o.group_key],
    );
    return rows.map((r) => ({
      sessionId: r.id,
      claudeSessionId: r.claude_session_id,
      role: r.role ?? guessRole({ name: r.project_name, path: r.project_path ?? r.cwd }),
      kind: r.kind,
      status: r.status,
      machineId: r.machine_id,
      isLead: r.id === o.lead_session_id,
      busyWithStep: r.busy,
    }));
  }

  /** Kirish + chiqish + kesh yozish tokenlari (kesh o'qish KIRMAYDI): lead va tayinlangan ishchilar, orkestratsiya boshlanganidan beri. */
  async tokensUsed(o: Pick<OrchRow, 'lead_session_id' | 'created_at'>, steps: ReadonlyArray<{ assigned_session_id: string | null }>, m: EntityManager | DataSource = this.dataSource): Promise<number> {
    const ids = [...new Set([o.lead_session_id, ...steps.map((s) => s.assigned_session_id)].filter((x): x is string => x !== null))];
    if (ids.length === 0) return 0;
    const rows: Array<{ n: string }> = await m.query(
      `SELECT COALESCE(SUM(tu.input_tokens + tu.output_tokens + tu.cache_creation_tokens), 0)::bigint AS n
         FROM token_usage tu JOIN sessions s ON s.machine_id = tu.machine_id AND s.claude_session_id = tu.session_id
        WHERE s.id = ANY($1::uuid[]) AND tu.ts >= $2`,
      [ids, o.created_at],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Qadamlar holatidan orkestratsiya holatini qayta hisoblaydi (tranzaksiya ichida). */
  private async recompute(orchId: string, m: EntityManager): Promise<OrchStatus> {
    const o: Array<{ status: OrchStatus }> = await m.query(`SELECT status FROM orchestrations WHERE id = $1 FOR UPDATE`, [orchId]);
    const cur = o[0]?.status ?? 'planning';
    const steps: Array<{ status: StepStatus }> = await m.query(`SELECT status FROM orchestration_steps WHERE orchestration_id = $1`, [orchId]);
    const next = deriveStatus(cur, steps);
    const terminal = next === 'completed' || next === 'cancelled';
    await m.query(`UPDATE orchestrations SET status = $2, updated_at = now(), finished_at = CASE WHEN $3::boolean THEN COALESCE(finished_at, now()) ELSE NULL END WHERE id = $1`, [orchId, next, terminal]);
    if (next !== cur) await this.audit.record({ actorKind: 'system', action: 'orchestration.status', target: orchId, details: { from: cur, to: next } }, m);
    return next;
  }

  // --- DTO ----------------------------------------------------------------------------------------

  async getDto(id: string): Promise<OrchestrationDto> {
    const rows: OrchRow[] = await this.dataSource.query(`${SELECT_ORCH} WHERE o.id = $1`, [id]);
    const o = rows[0];
    if (!o) throw new OrchError('orch_not_found', 'Orkestratsiya topilmadi');
    const steps = await this.stepRows(id);
    const used = await this.tokensUsed(o, steps);
    const stepDtos: OrchStepDto[] = steps.map((s) => ({
      id: s.id,
      key: s.key,
      position: s.position,
      title: s.title,
      role: s.role,
      machine: s.machine,
      cwd: s.cwd,
      dependsOn: s.depends_on,
      status: s.status,
      assignedSessionId: s.assigned_session_id,
      assignedLabel: s.assigned_label,
      dispatchMode: s.dispatch_mode,
      queueItemId: s.queue_item_id,
      commandId: s.dispatch_command_id,
      resultSummary: s.result_summary,
      lastError: s.last_error,
      dispatchedAt: iso(s.dispatched_at),
      finishedAt: iso(s.finished_at),
    }));
    return {
      id: o.id,
      goal: o.goal,
      groupKey: o.group_key,
      status: o.status,
      origin: o.origin,
      taskKey: o.task_key,
      projectId: o.project_id,
      leadSessionId: o.lead_session_id,
      leadLabel: o.lead_label,
      leadCommandId: o.lead_command_id,
      confirmation: o.confirmation,
      scope: o.scope ?? null,
      newSessionsUsed: o.new_sessions_used ?? 0,
      tokenBudget: Number(o.token_budget),
      tokensUsed: used,
      budgetExceeded: o.budget_exceeded_at !== null || used >= Number(o.token_budget),
      maxConcurrent: o.max_concurrent,
      cancelReason: o.cancel_reason,
      createdAt: o.created_at.toISOString(),
      updatedAt: o.updated_at.toISOString(),
      finishedAt: iso(o.finished_at),
      counts: countSteps(steps),
      steps: stepDtos,
    };
  }

  async list(q: ListOrchestrationsQuery): Promise<ListOrchestrationsResponse> {
    let groupKey = q.groupKey ?? null;
    if (!groupKey && q.projectId) {
      const g: Array<{ group_key: string }> = await this.dataSource.query(
        `SELECT ${GROUP_EXPR} AS group_key FROM projects p LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR} WHERE p.id = $1`,
        [q.projectId],
      );
      groupKey = g[0]?.group_key ?? null;
      if (!groupKey) return { items: [] };
    }
    const ids: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM orchestrations WHERE ($1::text IS NULL OR group_key = $1) AND ($2::text IS NULL OR status = $2)
        ORDER BY (status IN ${ACTIVE_ORCH}) DESC, created_at DESC LIMIT $3`,
      [groupKey, q.status ?? null, q.limit],
    );
    const items: OrchestrationDto[] = [];
    for (const r of ids) items.push(await this.getDto(r.id));
    return { items };
  }

  /** DTO'ni o'qib, `orchestration.changed` e'lon qiladi (hub `orchestration.updated` push). */
  private async changed(id: string): Promise<OrchestrationDto> {
    const dto = await this.getDto(id);
    this.bus.publish({ type: 'orchestration.changed', orchestrationId: id });
    return dto;
  }

  // --- REST: yaratish va to'xtatish ----------------------------------------------------------------

  async create(body: CreateOrchestrationBody, actor: OrchActor): Promise<OrchestrationDto> {
    const proj: Array<{ id: string; machine_id: string; group_key: string }> = await this.dataSource.query(
      `SELECT p.id, p.machine_id, ${GROUP_EXPR} AS group_key FROM projects p LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR} WHERE p.id = $1`,
      [body.projectId],
    );
    const project = proj[0];
    if (!project) throw new HttpException({ error: 'not_found', message: 'Project not found' }, 404);
    if (body.taskKey && extractTaskMarker(`#task:${body.taskKey}`) !== body.taskKey.toLowerCase()) {
      throw new HttpException({ error: 'invalid_task_key', message: 'taskKey is not a valid task id' }, 400);
    }
    let leadSessionId: string | null = null;
    let leadMachineId: string | null = null;
    let leadClaude: string | null = null;
    if (body.lead.type === 'session') {
      const rows: Array<{ id: string; machine_id: string; claude_session_id: string; group_key: string | null }> = await this.dataSource.query(
        `SELECT s.id, s.machine_id, s.claude_session_id, CASE WHEN p.id IS NULL THEN NULL ELSE ${GROUP_EXPR} END AS group_key
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR}
          WHERE s.id = $1 AND s.ended_at IS NULL`,
        [body.lead.sessionId],
      );
      const s = rows[0];
      if (!s) throw new HttpException({ error: 'not_found', message: 'Lead session not found or ended' }, 404);
      if (s.group_key !== project.group_key) throw new HttpException({ error: 'lead_not_in_group', message: 'The lead session must belong to this project\'s group' }, 400);
      leadSessionId = s.id;
      leadMachineId = s.machine_id;
      leadClaude = s.claude_session_id;
      const busy = await this.activeOrchOfLead(s.id);
      if (busy) throw new HttpException({ error: 'lead_busy', message: 'This session already leads an active orchestration' }, 409);
    } else {
      const paths: Array<{ path: string }> = await this.dataSource.query(
        `SELECT p.path FROM projects p LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR} WHERE p.machine_id = $1 AND ${GROUP_EXPR} = $2`,
        [body.lead.machineId, project.group_key],
      );
      if (!cwdWithinProjects(body.lead.cwd, paths.map((p) => p.path))) {
        throw new HttpException({ error: 'cwd_not_in_group', message: 'cwd must be inside one of this group\'s project folders' }, 400);
      }
      leadMachineId = body.lead.machineId;
    }
    const exempt = await this.isStepUpExempt(actor.deviceId);
    const confirmation: OrchConfirmation | null = exempt ? 'exempt_device' : null;
    // H-05: egasi ko'radigan va ijro etiladigan qamrov (tasdiq payti): guruh loyihalarining mashinalari + aniq papkalari.
    const scopeRows: Array<{ machine_id: string; machine_name: string; path: string }> = await this.dataSource.query(
      `SELECT p.machine_id, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, p.path
         FROM projects p JOIN machines m ON m.id = p.machine_id AND m.status = 'active' AND m.merged_into_id IS NULL
         LEFT JOIN project_links l ON l.base_key = ${BASE_EXPR}
        WHERE ${GROUP_EXPR} = $1 ORDER BY m.slug, p.path`,
      [project.group_key],
    );
    const scope = buildScope(scopeRows.map((r) => ({ machineId: r.machine_id, machineName: r.machine_name, path: r.path })), body.maxNewSessions ?? ORCH_LIMITS.defaultMaxNewSessions);
    const maxConcurrent = body.maxConcurrent ?? ORCH_LIMITS.defaultMaxConcurrent;
    const budget = body.tokenBudget ?? ORCH_LIMITS.defaultTokenBudget;
    const origin: OrchOrigin = actor.actorKind === 'telegram' ? 'telegram' : 'dashboard';

    const id = await this.dataSource.transaction(async (m): Promise<string> => {
      const ins: Array<{ id: string }> = await m.query(
        `INSERT INTO orchestrations (goal, group_key, status, origin, task_key, project_id, lead_session_id, lead_machine_id, confirmation, confirmed_at, confirmed_by_device_id, created_by_device_id, token_budget, max_concurrent, scope)
         VALUES ($1, $2, 'planning', $3, $4, $5, $6, $7, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, CASE WHEN $8::text IS NULL THEN NULL ELSE $9::uuid END, $9, $10, $11, $12::jsonb) RETURNING id`,
        [redactAndCap(body.goal, ORCH_LIMITS.goalMaxChars), project.group_key, origin, body.taskKey?.toLowerCase() ?? null, project.id, leadSessionId, leadMachineId, confirmation, actor.deviceId, budget, maxConcurrent, JSON.stringify(scope)],
      );
      const orchId = ins[0]?.id as string;
      await this.audit.record(
        {
          actorDeviceId: actor.deviceId,
          actorKind: actor.actorKind,
          action: 'orchestration.created',
          target: orchId,
          ip: actor.ip,
          details: { origin, group_key: project.group_key, project_id: project.id, lead: body.lead.type, lead_session_id: leadSessionId, token_budget: budget, max_concurrent: maxConcurrent, confirmation, goal_length: body.goal.length, scope_machines: scope.machines.map((x) => x.id), scope_roots: scope.cwdRoots.length, scope_modes: scope.modes, scope_max_new_sessions: scope.maxNewSessions },
        },
        m,
      );
      return orchId;
    });

    // Boshlang'ich prompt: mavjud lead = session.prompt; yangi lead = session.start (step-up o'z qoidasi bilan)
    const kickoff = renderKickoffPrompt({ orchestrationId: id, goal: redactAndCap(body.goal, ORCH_LIMITS.goalMaxChars), taskKey: body.taskKey?.toLowerCase() ?? null, maxSteps: ORCH_LIMITS.maxSteps, maxConcurrent });
    // Kickoff kartasi (Telegram step-up) tasdiq QAMROVINI sanab beradi: egasi aynan shuni tasdiqlaydi.
    const cmdActor: CommandActor = { deviceId: actor.deviceId, actorKind: actor.actorKind, ip: actor.ip, reviewNotes: formatScopeLines(scope) };
    let cmd: CommandDto;
    try {
      const res =
        body.lead.type === 'session'
          ? await this.commands.create({ type: 'session.prompt', sessionId: leadSessionId as string, text: kickoff }, cmdActor, `orch-kickoff-${id}`)
          : await this.commands.create(
              { type: 'session.start', machineId: body.lead.machineId, cwd: body.lead.cwd, prompt: kickoff, permissionMode: body.lead.permissionMode, ...(body.lead.model ? { model: body.lead.model } : {}), name: `orch lead ${id.slice(0, 6)}` },
              cmdActor,
              `orch-kickoff-${id}`,
            );
      cmd = res.command;
    } catch (err) {
      await this.abort(id, `kickoff_${this.failureCode(err)}`, actor);
      throw err;
    }
    if (cmd.status === 'rejected' || cmd.status === 'failed' || cmd.status === 'expired') {
      await this.abort(id, `kickoff_${cmd.errorCode ?? cmd.status}`, actor);
      throw new HttpException({ error: cmd.errorCode ?? 'kickoff_failed', message: cmd.errorMessage ?? 'The lead session could not be started or prompted' }, 422);
    }
    await this.dataSource.query(`UPDATE orchestrations SET lead_command_id = $2, updated_at = now() WHERE id = $1`, [id, cmd.id]);
    void leadClaude;
    return this.changed(id);
  }

  private async abort(id: string, reason: string, actor: OrchActor): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      await m.query(`UPDATE orchestrations SET status = 'cancelled', cancel_reason = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'planning'`, [id, reason]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'orchestration.aborted', target: id, ip: actor.ip, details: { reason } }, m);
    });
    await this.changed(id);
  }

  /** "To'xtatish": hamma ishtirokchi sessiyaga `session.stop`, kutayotgan buyruq/navbat elementlari bekor, orkestratsiya `cancelled`. */
  async cancel(id: string, actor: OrchActor, reason = 'owner'): Promise<CancelOrchestrationResponse> {
    const info = await this.dataSource.transaction(async (m) => {
      const rows: OrchRow[] = await m.query(`${SELECT_ORCH} WHERE o.id = $1 FOR UPDATE OF o`, [id]);
      const o = rows[0];
      if (!o) throw new HttpException({ error: 'not_found', message: 'Orchestration not found' }, 404);
      const steps = await this.stepRows(id, m);
      if (o.status === 'cancelled') return { already: true as const, sessions: [] as string[], commandIds: [] as string[], queueIds: [] as string[] };
      const active = steps.filter((s) => STEP_ACTIVE_STATUSES.includes(s.status));
      const sessions = [...new Set([o.lead_session_id, ...active.map((s) => s.assigned_session_id)].filter((x): x is string => x !== null))];
      await m.query(`UPDATE orchestration_steps SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE orchestration_id = $1 AND status IN ('pending', 'dispatched', 'running')`, [id]);
      await m.query(`UPDATE orchestrations SET status = 'cancelled', cancel_reason = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [id, reason]);
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'orchestration.cancelled', target: id, ip: actor.ip, details: { reason, previous_status: o.status, sessions: sessions.length, active_steps: active.length } },
        m,
      );
      return {
        already: false as const,
        sessions,
        commandIds: active.map((s) => s.dispatch_command_id).filter((x): x is string => x !== null),
        queueIds: active.map((s) => s.queue_item_id).filter((x): x is string => x !== null),
      };
    });
    let stopped = 0;
    let stopFailed = 0;
    if (!info.already) {
      for (const qid of info.queueIds) await this.queue.cancel(qid, { deviceId: actor.deviceId, actorKind: actor.actorKind, ip: actor.ip }).catch(() => undefined);
      for (const cid of info.commandIds) await this.commands.cancel(cid, { deviceId: actor.deviceId, actorKind: actor.actorKind, ip: actor.ip }).catch(() => undefined);
      for (const sid of info.sessions) {
        try {
          const res = await this.commands.create({ type: 'session.stop', sessionId: sid }, { deviceId: actor.deviceId, actorKind: actor.actorKind, ip: actor.ip }, `orch-stop-${id.slice(0, 8)}-${sid.slice(0, 8)}`);
          if (res.command.status === 'rejected' || res.command.status === 'failed' || res.command.status === 'expired') stopFailed++;
          else stopped++;
        } catch {
          stopFailed++;
        }
      }
    }
    const dto = await this.changed(id);
    if (!info.already) void this.notify('cancelled', dto);
    return { orchestration: dto, stopped, stopFailed };
  }

  /** L-22: orkestratsiyani yaratgan yoki tasdiqlagan qurilma revoke qilindi: faol orkestratsiyalar to'xtatiladi (audit bilan). */
  async cancelForRevokedDevice(deviceId: string): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM orchestrations WHERE status IN ${ACTIVE_ORCH} AND (created_by_device_id = $1 OR confirmed_by_device_id = $1)`,
      [deviceId],
    );
    const done: string[] = [];
    for (const r of rows) {
      try {
        await this.cancel(r.id, { deviceId, actorKind: 'system', ip: null }, 'creator_revoked');
        done.push(r.id);
      } catch (err) {
        this.logger.warn(`orchestration ${r.id} cancel on device revoke failed: ${errMsg(err)}`);
      }
    }
    return done;
  }

  private async isStepUpExempt(deviceId: string): Promise<boolean> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    const v = rows[0]?.value;
    return Array.isArray(v) && v.includes(deviceId);
  }

  // --- kuzatuv: buyruq/navbat/tik ------------------------------------------------------------------

  /** Lead buyrug'i va qadam dispatch buyrug'i holatini orkestratsiyaga qo'llaydi (sessiya bog'lash, rad/xato, step-up tasdig'i). */
  private async onCommandChanged(commandId: string): Promise<void> {
    const leads: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM orchestrations WHERE lead_command_id = $1`, [commandId]);
    const steps: Array<{ id: string; orchestration_id: string; dispatch_seq: number }> = await this.dataSource.query(
      `SELECT id, orchestration_id, dispatch_seq FROM orchestration_steps WHERE dispatch_command_id = $1`,
      [commandId],
    );
    if (leads.length === 0 && steps.length === 0) return;
    const dto = await this.commands.getDto(commandId);
    const touched = new Set<string>();

    for (const l of leads) {
      if (await this.applyLeadCommand(l.id, dto)) touched.add(l.id);
    }
    for (const s of steps) {
      if (await this.applyStepCommand(s, dto)) touched.add(s.orchestration_id);
    }
    // Step-up tasdig'i: bir marta orkestratsiyaga yoziladi
    if (dto.stepUp.confirmedAt && dto.stepUp.confirmedByDeviceId) {
      const orchIds = [...leads.map((l) => l.id), ...steps.map((s) => s.orchestration_id)];
      for (const oid of new Set(orchIds)) {
        const [upd] = (await this.dataSource.query(
          // H-05: faqat egasi yaratgan (qamrovi bor) orkestratsiya tasdiq oladi; lead yaratgani va eski (scope NULL) hech narsani qoplamaydi.
          `UPDATE orchestrations SET confirmation = 'telegram_step_up', confirmed_at = $2, confirmed_by_device_id = $3, updated_at = now()
            WHERE id = $1 AND confirmed_at IS NULL AND scope IS NOT NULL AND status IN ${ACTIVE_ORCH} RETURNING id`,
          [oid, dto.stepUp.confirmedAt, dto.stepUp.confirmedByDeviceId],
        )) as [Array<{ id: string }>, number];
        if (upd.length > 0) {
          await this.audit.record({ actorDeviceId: dto.stepUp.confirmedByDeviceId, actorKind: 'telegram', action: 'orchestration.confirmed', target: oid, details: { via: 'telegram_step_up', command_id: commandId } });
          touched.add(oid);
        }
      }
    }
    // H-05: existing_session nishoni tasdiqlandi: shu orkestratsiyada shu sessiyaga keyingi topshiriqlar qayta so'ramaydi (bir marta).
    if (dto.stepUp.confirmedAt && dto.sessionId) {
      for (const st of steps) {
        // TypeORM: UPDATE ... RETURNING -> [rows, affectedCount]
        const [r] = (await this.dataSource.query(
          `UPDATE orchestrations o SET confirmed_targets = array_append(confirmed_targets, $2::uuid), updated_at = now()
            FROM orchestration_steps t
           WHERE o.id = $1 AND t.id = $3 AND t.dispatch_mode = 'existing_session' AND t.assigned_session_id = $2::uuid
             AND NOT ($2::uuid = ANY(o.confirmed_targets)) RETURNING o.id`,
          [st.orchestration_id, dto.sessionId, st.id],
        )) as [Array<{ id: string }>, number];
        if (r.length > 0) {
          await this.audit.record({ actorDeviceId: dto.stepUp.confirmedByDeviceId, actorKind: 'telegram', action: 'orchestration.target_confirmed', target: st.orchestration_id, details: { target_session_id: dto.sessionId, command_id: commandId } });
          touched.add(st.orchestration_id);
        }
      }
    }
    for (const oid of touched) await this.changed(oid);
  }

  private async applyLeadCommand(orchId: string, dto: CommandDto): Promise<boolean> {
    let changed = false;
    if (dto.sessionId) {
      const r: Array<{ id: string }> = await this.dataSource.query(
        `UPDATE orchestrations o SET lead_session_id = s.id, lead_machine_id = s.machine_id, updated_at = now()
           FROM sessions s WHERE o.id = $1 AND o.lead_session_id IS NULL AND s.id = $2 RETURNING o.id`,
        [orchId, dto.sessionId],
      );
      changed = r.length > 0;
    }
    if (CMD_FAILED.has(dto.status)) {
      const r: Array<{ id: string }> = await this.dataSource.query(
        `UPDATE orchestrations SET status = 'cancelled', cancel_reason = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'planning' AND lead_session_id IS NULL RETURNING id`,
        [orchId, `lead_${dto.errorCode ?? dto.status}`],
      );
      if (r.length > 0) {
        await this.audit.record({ actorKind: 'system', action: 'orchestration.aborted', target: orchId, details: { reason: `lead_${dto.errorCode ?? dto.status}`, command_id: dto.id } });
        changed = true;
      }
    }
    return changed;
  }

  private async applyStepCommand(s: { id: string; orchestration_id: string; dispatch_seq: number }, dto: CommandDto): Promise<boolean> {
    let changed = false;
    let notifyFailed = false;
    if (dto.sessionId) {
      const r: Array<{ id: string }> = await this.dataSource.query(
        `UPDATE orchestration_steps SET assigned_session_id = $2, updated_at = now() WHERE id = $1 AND assigned_session_id IS NULL AND status IN ('dispatched', 'running') RETURNING id`,
        [s.id, dto.sessionId],
      );
      changed = r.length > 0;
    }
    if (CMD_FAILED.has(dto.status)) {
      const code = dto.errorCode ?? dto.status;
      await this.dataSource.transaction(async (m) => {
        const r: Array<{ id: string }> = await m.query(
          `UPDATE orchestration_steps SET status = 'failed', last_error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND dispatch_seq = $3 AND status = 'dispatched' RETURNING id`,
          [s.id, code, s.dispatch_seq],
        );
        if (r.length > 0) {
          changed = true;
          await this.audit.record({ actorKind: 'system', action: 'orchestration.step_failed', target: s.orchestration_id, details: { step_id: s.id, reason: code, command_id: dto.id } }, m);
          const before: Array<{ status: OrchStatus }> = await m.query(`SELECT status FROM orchestrations WHERE id = $1`, [s.orchestration_id]);
          const after = await this.recompute(s.orchestration_id, m);
          if (before[0] && before[0].status !== after && after === 'failed') notifyFailed = true;
        }
      });
    }
    if (notifyFailed) await this.notifyById('failed', s.orchestration_id);
    return changed;
  }

  /** Navbat elementi bog'langan qadam: sessiya ochilsa tayinlanadi, bekor/xato bo'lsa qadam `failed`. */
  private async onQueueChanged(queueId: string): Promise<void> {
    const steps: Array<{ id: string; orchestration_id: string; dispatch_seq: number }> = await this.dataSource.query(
      `SELECT id, orchestration_id, dispatch_seq FROM orchestration_steps WHERE queue_item_id = $1 AND status IN ('dispatched', 'running')`,
      [queueId],
    );
    if (steps.length === 0) return;
    const q: Array<{ status: string; last_session_id: string | null; last_error_code: string | null }> = await this.dataSource.query(`SELECT status, last_session_id, last_error_code FROM task_queue WHERE id = $1`, [queueId]);
    const item = q[0];
    if (!item) return;
    for (const s of steps) {
      if (item.last_session_id) {
        await this.dataSource.query(`UPDATE orchestration_steps SET assigned_session_id = $2, updated_at = now() WHERE id = $1 AND assigned_session_id IS NULL`, [s.id, item.last_session_id]);
      } else if (item.status === 'failed' || item.status === 'cancelled') {
        await this.dataSource.transaction(async (m) => {
          const r: Array<{ id: string }> = await m.query(
            `UPDATE orchestration_steps SET status = 'failed', last_error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND dispatch_seq = $3 AND status = 'dispatched' RETURNING id`,
            [s.id, item.last_error_code ?? `queue_${item.status}`, s.dispatch_seq],
          );
          if (r.length > 0) {
            await this.audit.record({ actorKind: 'system', action: 'orchestration.step_failed', target: s.orchestration_id, details: { step_id: s.id, reason: item.last_error_code ?? `queue_${item.status}`, queue_item_id: queueId } }, m);
            await this.recompute(s.orchestration_id, m);
          }
        });
      }
      await this.changed(s.orchestration_id);
    }
  }

  /** Ishchi sessiya (`new_session`/`queue`) ochilgach, buyruq natijasidan tayinlashni kutmasdan chaqiriladi. */
  private async lazyAssign(sessionId: string): Promise<void> {
    const rows: Array<{ id: string; dispatch_command_id: string | null; queue_item_id: string | null }> = await this.dataSource.query(
      `SELECT id, dispatch_command_id, queue_item_id FROM orchestration_steps WHERE assigned_session_id IS NULL AND status IN ('dispatched', 'running') AND (dispatch_command_id IS NOT NULL OR queue_item_id IS NOT NULL) LIMIT 20`,
    );
    for (const r of rows) {
      let sid: string | null = null;
      if (r.dispatch_command_id) sid = (await this.commands.getDto(r.dispatch_command_id).catch(() => null))?.sessionId ?? null;
      if (!sid && r.queue_item_id) {
        const q: Array<{ last_session_id: string | null }> = await this.dataSource.query(`SELECT last_session_id FROM task_queue WHERE id = $1`, [r.queue_item_id]);
        sid = q[0]?.last_session_id ?? null;
      }
      if (sid === sessionId) await this.dataSource.query(`UPDATE orchestration_steps SET assigned_session_id = $2, updated_at = now() WHERE id = $1 AND assigned_session_id IS NULL`, [r.id, sid]);
    }
  }

  /** Fon tik: byudjet, tugagan ishchi sessiyalar, lead yo'qolgan orkestratsiyalar. Idempotent. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM orchestrations WHERE status IN ('planning', 'running', 'failed') ORDER BY updated_at LIMIT 50`);
      for (const { id } of active) {
        await this.reconcileSessions(id).catch((err: unknown) => this.logger.warn(`orchestration ${id.slice(0, 8)} reconcile failed: ${errMsg(err)}`));
        await this.checkBudget(id).catch((err: unknown) => this.logger.warn(`orchestration ${id.slice(0, 8)} budget check failed: ${errMsg(err)}`));
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Faol qadamning ishchi sessiyasi tugagan va grace muddatida qayta ochilmagan (hisobotsiz): qadam `failed(session_ended)`. */
  private async reconcileSessions(orchId: string): Promise<void> {
    const rows: Array<{ id: string; dispatch_seq: number }> = await this.dataSource.query(
      `SELECT t.id, t.dispatch_seq FROM orchestration_steps t JOIN sessions s ON s.id = t.assigned_session_id
        WHERE t.orchestration_id = $1 AND t.status IN ('dispatched', 'running') AND s.ended_at IS NOT NULL AND s.ended_at < now() - ($2::int * interval '1 second')`,
      [orchId, SESSION_END_GRACE_S],
    );
    if (rows.length === 0) return;
    let before: OrchStatus = 'running';
    let after: OrchStatus = 'running';
    await this.dataSource.transaction(async (m) => {
      const cur: Array<{ status: OrchStatus }> = await m.query(`SELECT status FROM orchestrations WHERE id = $1 FOR UPDATE`, [orchId]);
      before = cur[0]?.status ?? 'running';
      for (const r of rows) {
        const u: Array<{ id: string }> = await m.query(
          `UPDATE orchestration_steps SET status = 'failed', last_error = 'session_ended', finished_at = now(), updated_at = now() WHERE id = $1 AND dispatch_seq = $2 AND status IN ('dispatched', 'running') RETURNING id`,
          [r.id, r.dispatch_seq],
        );
        if (u.length > 0) await this.audit.record({ actorKind: 'system', action: 'orchestration.step_failed', target: orchId, details: { step_id: r.id, reason: 'session_ended' } }, m);
      }
      after = await this.recompute(orchId, m);
    });
    const dto = await this.changed(orchId);
    if (after !== before && after === 'failed') void this.notify('failed', dto);
  }

  /** Byudjet oshdi: yangi dispatch to'xtatiladi (bayroq), ogohlantirish bir marta. Sessiyalarni O'ZI to'xtatmaydi. */
  async checkBudget(orchId: string): Promise<boolean> {
    const rows: OrchRow[] = await this.dataSource.query(`${SELECT_ORCH} WHERE o.id = $1`, [orchId]);
    const o = rows[0];
    if (!o || !['planning', 'running', 'failed'].includes(o.status) || o.budget_exceeded_at !== null) return false;
    const steps = await this.stepRows(orchId);
    const used = await this.tokensUsed(o, steps);
    if (used < Number(o.token_budget)) return false;
    const upd: Array<{ id: string }> = await this.dataSource.query(`UPDATE orchestrations SET budget_exceeded_at = now(), updated_at = now() WHERE id = $1 AND budget_exceeded_at IS NULL RETURNING id`, [orchId]);
    if (upd.length === 0) return false;
    await this.audit.record({ actorKind: 'system', action: 'orchestration.budget_exceeded', target: orchId, details: { tokens_used: used, token_budget: Number(o.token_budget) } });
    const dto = await this.changed(orchId);
    void this.notify('budget', dto);
    return true;
  }

  // --- bildirishnoma -------------------------------------------------------------------------------

  private async notifyById(kind: OrchNoticeKind, id: string): Promise<void> {
    await this.notify(kind, await this.getDto(id));
  }

  private async notify(kind: OrchNoticeKind, dto: OrchestrationDto): Promise<void> {
    if (!this.notifier) return;
    // Bir xil holat uchun ikki marta emas (notified_status = oxirgi yuborilgan tur)
    const mark = `${kind}`;
    const upd: Array<{ id: string }> = await this.dataSource.query(
      `UPDATE orchestrations SET notified_status = $2 WHERE id = $1 AND (notified_status IS DISTINCT FROM $2) RETURNING id`,
      [dto.id, mark],
    );
    if (upd.length === 0) return;
    try {
      await this.notifier.send(formatOrchNotice(kind, dto));
    } catch (err) {
      this.logger.warn(`orchestration notify failed: ${errMsg(err)}`);
    }
  }
}
