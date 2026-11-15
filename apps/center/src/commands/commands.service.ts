import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { COMMAND_LIMITS, SummarizeResultSchema, canonicalJson, isConfigCommandType, isGitCommandType, isProjectCommandType, isCheckpointCommandType, isDeployCommandType, isDeployExecType } from '@commander/contracts';
import { configNeedsStepUp } from './config-precheck.js';
import type {
  DiffResult,
  AgentControlState,
  CommandAckPayload,
  CommandDispatchPayload,
  CommandDto,
  CommandResultData,
  CommandResultPayload,
  CommandState,
  CommandType,
  CreateCommandBody,
  CreateCommandResponse,
  ListCommandsQuery,
  ListCommandsResponse,
  ConfigChunkPayload,
  ConfigCommandBody,
  AssistantCommandBody,
  LogsCommandBody,
  DeployCommandBody,
  CheckpointCommandBody,
  ProjectCommandBody,
  ReadMdResult,
  SummarizeResult,
} from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { reviewForPrompt } from './command-review.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { CommandSignerService } from './command-signer.service.js';
import { hashCommandPayload, newDispatchNonce } from './command-signer.js';
import { SignerRejectedError } from './signer-client.js';
import { applyAgentAck, applyAgentResult } from './command-state.js';
import { CommandRejectedError } from './commands.errors.js';
import { COMMANDS_OPTIONS } from './commands.options.js';
import type { CommandsOptions } from './commands.options.js';
import { needsStepUp, precheckCommand } from './control-logic.js';
import type { CommandRejection } from './control-logic.js';
import { StepUpRegistry } from './step-up.js';
import { handleGitResult } from './git-result.js';
import { deployReview, repoAuditDetails, repoSecret, repoStoredPayload, sanitizeRepoResult } from './deploy-commands.js';
import { deployNotifications } from '../deploy/deploy-notify.js';
import { handleScanResult } from './scan-result.js';
import type { TransientDiff } from './git-result.js';
import { gitNotifications } from '../projects/git-notify.js';
import type { CiFailureNotice } from '../projects/git-notify.js';

export interface CommandActor {
  deviceId: string;
  actorKind: AuditActorKind;
  ip: string | null;
  /**
   * `telegram_inline`: tasdiq Telegram chatining o'zida, foydalanuvchi ko'rgan yakuniy xulosa kartasidagi "Ochish" tugmasi bilan
   * berilgan (`/new`). Faqat `session.start` va faqat `actorKind='telegram'` uchun hisobga olinadi (boshqa hollarda e'tiborsiz);
   * REST controller buni HECH QACHON o'rnatmaydi, shu sabab tashqaridan soxtalashtirib bo'lmaydi. Ikkinchi Telegram so'rovi yuborilmaydi.
   */
  /**
   * `queue_item` (3.1): navbat elementi yaratilganda step-up allaqachon o'tgan (istisno qurilma yoki Telegram inline); scheduler
   * (`actorKind='system'`) shu belgi bilan `session.start` yaratadi. Faqat `system` aktori va `session.start` uchun hisobga olinadi;
   * REST controller va Telegram uni HECH QACHON o'rnatmaydi.
   */
  /**
   * `orchestration` (3.9): orkestratsiya egasi tasdiqlagan (istisno qurilma / Telegram); shu orkestratsiya ichidagi `session.start`
   * dispatch'lari qayta step-up so'ramaydi. Faqat `system` aktori va `session.start` uchun; REST controller va Telegram uni HECH QACHON o'rnatmaydi.
   */
  confirmation?: 'telegram_inline' | 'queue_item' | 'orchestration';
  /**
   * H-05: step-up'ni MAJBURLASH (masalan orkestratsiya mavjud sessiyaga birinchi marta prompt yuboradi). Faqat `system` aktori;
   * REST controller va Telegram buni HECH QACHON o'rnatmaydi. Istisno qurilma ham uni aylanib o'tmaydi.
   */
  forceStepUp?: boolean;
  /** H-05: step-up kartasida ko'rsatiladigan qo'shimcha qatorlar (qamrov, nega alohida tasdiq); REST controller buni o'rnatmaydi. */
  reviewNotes?: string[];
}

const OPEN_STATES = `('awaiting_confirmation','pending','sent','acked','running')`;
const PREVIEW_CHARS = 500;
const STORED_PROMPT_CHARS = 2000;

interface CommandRow {
  id: string;
  type: CommandType;
  status: CommandState;
  machine_id: string;
  machine_slug: string;
  project_id: string | null;
  session_uuid: string | null;
  payload: Record<string, unknown>;
  requested_by_device_id: string;
  confirmed_by_device_id: string | null;
  confirmed_at: Date | null;
  step_up_required: boolean;
  error_code: string | null;
  error_message: string | null;
  result: CommandResultData | null;
  created_at: Date;
  sent_at: Date | null;
  acked_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
}

const SELECT_DTO = `
  SELECT c.id, c.type, c.status, c.machine_id, m.slug AS machine_slug, c.project_id,
         COALESCE(c.session_id, (SELECT s.id FROM sessions s
            WHERE s.machine_id = c.machine_id
              AND s.claude_session_id = COALESCE(c.payload->>'claudeSessionId', c.result->>'claudeSessionId') LIMIT 1)) AS session_uuid,
         c.payload, c.requested_by_device_id, c.confirmed_by_device_id, c.confirmed_at, c.step_up_required,
         c.error_code, c.error_message, c.result, c.created_at, c.sent_at, c.acked_at, c.finished_at, c.expires_at
    FROM commands c JOIN machines m ON m.id = c.machine_id`;

const isReview = (v: unknown): v is { required: boolean; reasons: string[] } =>
  typeof v === 'object' && v !== null && typeof (v as { required?: unknown }).required === 'boolean' && Array.isArray((v as { reasons?: unknown }).reasons);
/** `config.apply` xulosasi (H-06) ko'proq qator talab qiladi. */
const previewLimit = (type: string): number => (type === 'config.apply' ? 2000 : PREVIEW_CHARS);
const reviewField = (r: ReturnType<typeof reviewForPrompt>, notes: readonly string[] = []): { review?: NonNullable<ReturnType<typeof reviewForPrompt>> } => {
  const reasons = [...notes.map((n) => n.slice(0, 300)), ...(r?.reasons ?? [])].slice(0, 16);
  return reasons.length === 0 ? {} : { review: { required: r?.required ?? false, reasons } };
};
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function toCommandDto(r: CommandRow, stepUpTtlMs: number = COMMAND_LIMITS.stepUpTtlMs): CommandDto {
  const p = r.payload;
  const preview = str(p['promptRedacted']);
  const mode = str(p['permissionMode']);
  return {
    id: r.id,
    type: r.type as CommandDto['type'],
    status: r.status,
    machineId: r.machine_id,
    machineSlug: r.machine_slug,
    projectId: r.project_id,
    sessionId: r.session_uuid,
    claudeSessionId: str(p['claudeSessionId']) ?? r.result?.claudeSessionId ?? null,
    cwd: str(p['cwd']),
    permissionMode: (mode as CommandDto['permissionMode']) ?? null,
    model: str(p['model']),
    promptLength: typeof p['promptLength'] === 'number' ? p['promptLength'] : null,
    promptPreview: preview === null ? null : preview.length > previewLimit(r.type) ? `${preview.slice(0, previewLimit(r.type))}…` : preview,
    requestedByDeviceId: r.requested_by_device_id,
    ...(isReview(p['review']) ? { review: p['review'] } : {}),
    stepUp: {
      required: r.step_up_required,
      via: r.step_up_required ? 'telegram' : null,
      expiresAt: r.step_up_required ? new Date(r.created_at.getTime() + stepUpTtlMs).toISOString() : null,
      confirmedAt: iso(r.confirmed_at),
      confirmedByDeviceId: r.confirmed_by_device_id,
    },
    errorCode: r.error_code,
    errorMessage: r.error_message,
    result: r.result,
    createdAt: r.created_at.toISOString(),
    sentAt: iso(r.sent_at),
    ackedAt: iso(r.acked_at),
    finishedAt: iso(r.finished_at),
    expiresAt: r.expires_at.toISOString(),
  };
}

type Secret = { body: DispatchBody; until: number };
/** `project.read_md` natijasi: faqat xotirada (md matni DB'ga yozilmaydi), qisqa muddat. */
type Transient = { md: ReadMdResult; until: number };
const TRANSIENT_TTL_MS = 2 * 60_000;
/** Yuborilgan tana (`create` argumenti): sessiya yoki loyiha buyrug'i. */
export type AnyCommandBody = CreateCommandBody | ProjectCommandBody | ConfigCommandBody | AssistantCommandBody | LogsCommandBody | DeployCommandBody | CheckpointCommandBody;

/** 6.11: yangi `session.start` darvozasi: rad etilsa `CommandRejection` (`rejected` qator yoziladi), aks holda `null`. */
export type StartGate = (i: { machineId: string; cwd: string }) => Promise<CommandRejection | null>;
/** Agentga boradigan (imzolanadigan) tana: `type` + `payload`. */
type DispatchBody = Pick<CommandDispatchPayload, 'type' | 'payload'> & {
  /** `config.apply` (3.7): gzip bundle bo'laklari; `command.dispatch` dan OLDIN yuboriladi (imzolanmaydi: yaxlitlik payload'dagi sha256 bilan). */
  chunks?: ConfigChunkPayload[];
};

export type ConfirmOutcome = 'confirmed' | 'not_pending' | 'expired' | 'same_device' | 'lockdown' | 'lost';

/**
 * Remote buyruq konveyeri (2.3-2.7, CLAUDE.md qoida 1-4).
 *
 *  - HAR amal `commands` qatori + `audit_log` (`command.created`, tranzaksiya ichida) bilan boshlanadi; dispatchdan OLDIN
 *    `command.dispatched` auditi bilan holat `sent` ga o'tadi (audit yozilmasa dispatch yo'q);
 *  - step-up (start, acceptEdits/auto rejimi): Telegram'da boshqa qurilma tasdiqlaguncha dispatch yo'q; kanal yo'q bo'lsa
 *    `failed(step_up_unavailable)`, hech qachon avtomatik tasdiq;
 *  - haqiqiy prompt matni FAQAT xotirada (`secrets`, tasdiq oynasi davomida); DB'ga redakt qilingan nusxa. Center
 *    qayta ishga tushsa tasdiq kutayotgan buyruqlar `failed(center_restarted)`;
 *  - lockdown: HTTP guard yaratishni 403 qiladi; tasdiq va dispatch paytida qayta tekshiriladi;
 *  - agent offline bo'lsa navbatga qo'yilmaydi (eskirgan buyruq keyinroq bajarilmasin).
 */
@Injectable()
export class CommandsService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(CommandsService.name);
  private readonly secrets = new Map<string, Secret>();
  private readonly transient = new Map<string, Transient>();
  /** `config.*` natijasi (3.7): faqat xotirada (diff/mazmun DB'ga yozilmaydi), qisqa muddat. */
  private readonly configTransient = new Map<string, { config: unknown; until: number }>();
  /** `assistant.ask` natijasi (6.2): javob matni faqat xotirada (DB'ga yozilmaydi), qisqa muddat. */
  private readonly assistantTransient = new Map<string, { value: unknown; until: number }>();
  /** `project.diff` natijasi (3.5): faqat xotirada, qisqa muddat. */
  private readonly gitTransient = new Map<string, TransientDiff>();
  /** `deploy.inspect` (6.5) va `git.checkpoint*` (6.9) natijalari: faqat xotirada, qisqa muddat. */
  private readonly repoTransient = new Map<string, { value: unknown; until: number }>();
  private readonly limiters = new Map<string, FixedWindowLimiter>();
  /** 6.11: yangi `session.start` darvozasi (kunlik byudjet). `BudgetsService` o'zini ro'yxatdan o'tkazadi (modul sikli yo'q). */
  private startGate: StartGate | null = null;
  private extraStartGates: StartGate[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly lockdown: LockdownService,
    private readonly dispatch: AgentDispatchService,
    private readonly bus: RealtimeBus,
    private readonly stepUp: StepUpRegistry,
    private readonly signer: CommandSignerService,
    @Inject(COMMANDS_OPTIONS) private readonly options: CommandsOptions,
  ) {
    for (const [type, [limit, windowMs]] of Object.entries(options.rateLimits)) this.limiters.set(type, new FixedWindowLimiter(limit, windowMs));
  }

  /** 6.11: `session.start` darvozasi (navbat/orkestratsiya/dashboard/Telegram hammasi shu yerdan o'tadi). `null` qaytarsa ruxsat. */
  setStartGate(gate: StartGate | null): void {
    this.startGate = gate;
  }

  /** 6.12: qo'shimcha `session.start` darvozasi (haftalik limit tezligi); `setStartGate` bilan birga ishlaydi. Qaytgan funksiya ro'yxatdan chiqaradi. */
  addStartGate(gate: StartGate): () => void {
    this.extraStartGates.push(gate);
    return () => {
      this.extraStartGates = this.extraStartGates.filter((g) => g !== gate);
    };
  }

  private async gateRejection(body: AnyCommandBody, target: Target): Promise<CommandRejection | null> {
    if (body.type !== 'session.start') return null;
    const input = { machineId: target.machineId, cwd: body.cwd };
    if (this.startGate) {
      const r = await this.startGate(input);
      if (r) return r;
    }
    for (const gate of this.extraStartGates) {
      const r = await gate(input);
      if (r) return r;
    }
    return null;
  }

  private async isStepUpExempt(deviceId: string): Promise<boolean> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids'`);
    const v = rows[0]?.value;
    return Array.isArray(v) && v.includes(deviceId);
  }

  async onModuleInit(): Promise<void> {
    // Xotiradagi maxfiy tana restartda yo'qoladi: tasdiq kutayotgan/dispatch qilinmagan buyruqlar bajarib bo'lmaydi.
    await this.failStranded();
    this.sweepTimer = setInterval(
      () => void this.sweep().catch((err: unknown) => this.logger.error(`command sweep failed: ${err instanceof Error ? err.message : String(err)}`)),
      this.options.sweepMs,
    );
    this.sweepTimer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // --- klient -> center ------------------------------------------------------------------------

  async create(body: AnyCommandBody, actor: CommandActor, idempotencyKey: string | undefined, now: Date = new Date()): Promise<CreateCommandResponse> {
    const key = idempotencyKey ?? `auto-${randomUUID()}`;
    const requestHash = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');

    const existing = await this.findIdempotent(actor.deviceId, key, requestHash);
    if (existing) return { command: existing, idempotent: true };

    const hit = this.limiters.get(body.type)?.hit(actor.deviceId, now.getTime()) ?? 0;
    const limit = this.options.rateLimits[body.type][0];
    if (hit > limit) {
      const retry = this.limiters.get(body.type)?.retryAfterSeconds(actor.deviceId, now.getTime()) ?? 1;
      throw new HttpException({ error: 'rate_limited', message: `Too many ${body.type} commands; retry in ${retry}s`, retryAfterSeconds: retry }, 429);
    }

    const target = await this.resolveTarget(body);
    // 3.10: nom berilmasa claude.ai/code'da topish uchun doimiy default nom (`cmdr-<sessiya id boshi>`; bg ochishda tasodifiy qisqa id).
    if (body.type === 'session.remote_control' && body.enable && !body.name && target.session) body = { ...body, name: `cmdr-${target.session.claudeSessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'session'}` };
    if (body.type === 'session.start' && body.remoteControl && !body.name) body = { ...body, name: `cmdr-${randomUUID().slice(0, 4)}` };
    const preRejection = precheckCommand({
      type: body.type,
      ...('permissionMode' in body ? { permissionMode: body.permissionMode } : {}),
      machineOnline: target.machineOnline,
      control: target.control,
      machineOs: target.machineOs,
      session: target.session,
      ...(body.type === 'session.start' && body.remoteControl ? { remoteControl: true } : {}),
      ...(body.type === 'config.apply' ? { configDryRun: body.apply.dryRun } : {}),
    });
    const rejection = preRejection ?? (await this.gateRejection(body, target));
    const mode = 'permissionMode' in body ? body.permissionMode : undefined;
    // Egasi tanlagan istisno (settings 'commands.stepup_exempt_device_ids'): masalan faqat shu Mac'dagi lokal dashboard.
    // `auto` rejim istisnoga kirmaydi — u doim Telegram tasdig'ini talab qiladi.
    // Deploy ijrosi (6.5): HECH QANDAY istisno yo'q (Mac dashboard ham Telegram tasdig'ini talab qiladi).
    const exempt = mode !== 'auto' && !isDeployExecType(body.type) && (await this.isStepUpExempt(actor.deviceId));
    // Remote Control'ni yoqish (3.10): Telegram chat ichidagi aniq tasdiq (/s kartasi) ikkinchi so'rovni almashtiradi; boshqa aktorlar uchun e'tiborsiz.
    const inlineConfirmed =
      // Deploy/rollback va checkpoint'dan qaytarish: Telegram chat ichidagi aniq tasdiq kartasi (target+commit+xesh ko'rsatilgan) ikkinchi so'rovni almashtiradi
      ((isDeployExecType(body.type) || body.type === 'git.checkpoint_restore') && actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram') ||
      // PR ochish (3.5): Telegram chat ichidagi aniq tasdiq ("PR ochish" kartasi) ikkinchi so'rovni almashtiradi
      (body.type === 'project.open_pr' && actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram') ||
      (body.type === 'session.remote_control' && body.enable && actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram') ||
      // 6.14: Telegram'dagi aniq tasdiq kartasi ("Davom ettirish": mashina, papka) ikkinchi so'rovni almashtiradi
      (body.type === 'session.resume' && actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram') ||
      (body.type === 'session.start' &&
      ((actor.confirmation === 'telegram_inline' && actor.actorKind === 'telegram') || ((actor.confirmation === 'queue_item' || actor.confirmation === 'orchestration') && actor.actorKind === 'system')));
    const cfgStepUp = body.type === 'config.apply' ? configNeedsStepUp(body.type, body.apply.dryRun) : body.type === 'config.rollback' ? configNeedsStepUp(body.type, false) : false;
    const forced = actor.forceStepUp === true && actor.actorKind === 'system' && (body.type === 'session.prompt' || body.type === 'session.start');
    const stepUp = rejection === null && (forced || ((needsStepUp(body.type, mode, body.type === 'session.remote_control' ? body.enable : undefined) || cfgStepUp) && !exempt && !inlineConfirmed));
    const secret = this.buildSecret(body, target);

    let id: string;
    try {
      id = await this.dataSource.transaction((m) => this.insert(m, { body, actor, key, requestHash, target, rejection, stepUp, inlineConfirmed, now }));
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        const raced = await this.findIdempotent(actor.deviceId, key, requestHash);
        if (raced) return { command: raced, idempotent: true };
      }
      throw err;
    }

    this.bus.publish({ type: 'command.changed', commandId: id });
    if (rejection) return { command: await this.getDto(id), idempotent: false };

    if (stepUp) {
      this.secrets.set(id, { body: secret, until: now.getTime() + COMMAND_LIMITS.stepUpTtlMs + 5_000 });
      if (!(await this.stepUp.available())) {
        await this.fail(id, 'step_up_unavailable', 'Telegram confirmation is not available; the command was not executed', actor.actorKind);
      } else {
        const delivered = await this.stepUp.request(await this.getDto(id));
        if (delivered === 0) await this.fail(id, 'step_up_unavailable', 'The confirmation request could not be delivered to Telegram; the command was not executed', actor.actorKind);
      }
      return { command: await this.getDto(id), idempotent: false };
    }

    await this.dispatchCommand(id, secret, actor);
    return { command: await this.getDto(id), idempotent: false };
  }

  /** Telegram "Tasdiqlash". Boshqa qurilma, muddat, lockdown tekshiriladi; keyin dispatch. */
  async confirm(id: string, actor: CommandActor, now: Date = new Date()): Promise<{ outcome: ConfirmOutcome; command: CommandDto }> {
    const lockdown = (await this.lockdown.state()).enabled;
    const res = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: CommandState; expires_at: Date; requested_by_device_id: string; type: CommandType }> = await m.query(
        `SELECT status, expires_at, requested_by_device_id, type FROM commands WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException({ error: 'not_found', message: 'Command not found' });
      if (row.status !== 'awaiting_confirmation') return 'not_pending' as const;
      if (row.expires_at.getTime() <= now.getTime()) {
        await this.finish(m, id, 'expired', 'step_up_expired', 'The confirmation window has passed', actor, 'command.expired');
        return 'expired' as const;
      }
      if (row.requested_by_device_id === actor.deviceId) return 'same_device' as const;
      if (lockdown) {
        await this.finish(m, id, 'rejected', 'lockdown', 'Lockdown is active', actor, 'command.rejected');
        return 'lockdown' as const;
      }
      await m.query(`UPDATE commands SET status = 'pending', confirmed_by_device_id = $2, confirmed_at = $3 WHERE id = $1`, [id, actor.deviceId, now]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'command.confirmed', target: id, ip: actor.ip, details: { type: row.type } }, m);
      return 'confirmed' as const;
    });

    let outcome: ConfirmOutcome = res;
    if (res === 'confirmed') {
      const secret = this.secrets.get(id);
      if (!secret || secret.until < now.getTime()) {
        await this.fail(id, 'center_restarted', 'The command payload is no longer available; create the command again', 'system');
        outcome = 'lost';
      } else {
        await this.dispatchCommand(id, secret.body, actor);
      }
    }
    this.bus.publish({ type: 'command.changed', commandId: id });
    return { outcome, command: await this.getDto(id) };
  }

  /** REST dashboard tasdig'i: faqat `review.required` buyruqlar (qolganlari Telegram'da). */
  async confirmReviewed(id: string, actor: CommandActor, now: Date = new Date()): Promise<{ outcome: ConfirmOutcome; command: CommandDto }> {
    const dto = await this.getDto(id);
    if (dto.review?.required !== true) {
      throw new ConflictException({ error: 'use_telegram', message: 'This command is confirmed in Telegram; only commands that need a full review are confirmed from the dashboard' });
    }
    return this.confirm(id, actor, now);
  }

  /** Telegram "Bekor" yoki REST `cancel`: faqat tasdiq kutayotgan buyruq. `true` = bekor qilindi. */
  async cancel(id: string, actor: CommandActor): Promise<{ cancelled: boolean; command: CommandDto }> {
    const cancelled = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: CommandState }> = await m.query(`SELECT status FROM commands WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Command not found' });
      if (rows[0].status !== 'awaiting_confirmation') return false;
      await this.finish(m, id, 'rejected', 'step_up_cancelled', 'Cancelled before confirmation', actor, 'command.cancelled');
      return true;
    });
    this.secrets.delete(id);
    if (cancelled) this.bus.publish({ type: 'command.changed', commandId: id });
    return { cancelled, command: await this.getDto(id) };
  }

  // --- agent -> center -------------------------------------------------------------------------

  async handleAck(machineId: string, p: CommandAckPayload): Promise<void> {
    const changed = await this.dataSource.transaction(async (m) => {
      const row = await this.lockOwn(m, p.commandId, machineId);
      const outcome = applyAgentAck(row.status);
      if (outcome.kind === 'noop') return false;
      await m.query(`UPDATE commands SET status = 'acked', acked_at = now() WHERE id = $1`, [p.commandId]);
      return true;
    });
    if (changed) {
      this.bus.publish({ type: 'command.changed', commandId: p.commandId });
      void this.notifyDeployStarted(p.commandId);
    }
  }

  async handleResult(machineId: string, p: CommandResultPayload): Promise<void> {
    const res = await this.dataSource.transaction(async (m) => {
      const row = await this.lockOwn(m, p.commandId, machineId);
      const outcome = applyAgentResult(row.status, p);
      if (outcome.kind === 'noop') {
        if (row.status === 'expired' || row.status === 'failed') {
          await this.audit.record({ actorKind: 'agentd', action: 'command.late_result', target: p.commandId, details: { state: p.state, was: row.status } }, m);
        }
        return null;
      }
      let to = outcome.to;
      let result = p.result;
      let error = p.error;
      let summary: SummarizeResult | null = null;
      let gitNotice: CiFailureNotice | null = null;
      let deployFinished = false;
      if (to === 'done' && isConfigCommandType(row.type)) {
        // Sozlamalar natijasi (3.7): to'liq natija xotirada (REST so'rovi olib ketadi), DB'ga faqat qisqa izoh.
        if (p.result?.config !== undefined) this.configTransient.set(p.commandId, { config: p.result.config, until: Date.now() + TRANSIENT_TTL_MS });
        result = { ...(p.result?.detail ? { detail: p.result.detail } : {}) };
      }
      if (to === 'done' && row.type === 'assistant.ask') {
        if (p.result?.assistant !== undefined) {
          this.assistantTransient.set(p.commandId, { value: p.result.assistant, until: Date.now() + TRANSIENT_TTL_MS });
          result = { ...(p.result.detail ? { detail: p.result.detail } : {}) };
        } else {
          to = 'failed';
          error = { code: 'invalid_result', message: 'The agent returned no answer' };
        }
      }
      if (to === 'done' && isProjectCommandType(row.type)) {
        // Loyiha natijalari: md matni va xulosa matni `commands.result`ga TUSHMAYDI (md xotirada, xulosa `daily_summaries`da).
        if (row.type === 'project.read_md') {
          if (p.result?.md) {
            this.transient.set(p.commandId, { md: p.result.md, until: Date.now() + TRANSIENT_TTL_MS });
            result = { detail: `${p.result.md.bytes} bytes${p.result.md.truncated ? ', truncated' : ''}` };
          } else {
            to = 'failed';
            error = { code: 'invalid_result', message: 'The agent returned no md content' };
          }
        } else if (isGitCommandType(row.type)) {
          // Git/PR (3.5): diff xotirada, PR/CI jadvallarga (bir tranzaksiyada); xulosa matni commands.result'ga tushmaydi
          const g = await handleGitResult(m, { commandId: p.commandId, type: row.type, projectId: row.project_id, result: p.result }, this.gitTransient);
          if (g.result) result = g.result;
          if (g.error) {
            to = 'failed';
            error = g.error;
          }
          gitNotice = g.notice ?? null;
        } else if (row.type === 'project.scan') {
          // Xavfsizlik tekshiruvi (6.10): topilmalar `project_scans`ga (redakt qilingan), `commands.result`ga faqat qisqa izoh
          const sc = await handleScanResult(m, { commandId: p.commandId, projectId: row.project_id, machineId, result: p.result });
          if (sc.result) result = sc.result;
          if (sc.error) {
            to = 'failed';
            error = sc.error;
          }
        } else if (row.type === 'project.summarize') {
          const parsed = SummarizeResultSchema.safeParse(p.result?.summary);
          if (parsed.success) {
            summary = parsed.data;
            result = { detail: `${parsed.data.scores.length} scores` };
          } else {
            to = 'failed';
            result = { detail: 'invalid summary' };
            error = { code: 'invalid_result', message: 'The agent returned an invalid summary' };
          }
        }
      }
      if ((isDeployCommandType(row.type) || isCheckpointCommandType(row.type)) && (to === 'done' || to === 'failed' || to === 'rejected')) {
        // Deploy (6.5) / checkpoint (6.9): natija sxema bo'yicha tekshiriladi; DB'ga xom `unknown` tushmaydi (xulosa faqat nomlar/holatlar)
        const r = sanitizeRepoResult(row.type, to, p.result);
        result = r.result;
        if (r.error) {
          to = 'failed';
          error = r.error;
        } else if (r.transient !== undefined) this.repoTransient.set(p.commandId, { value: r.transient, until: Date.now() + TRANSIENT_TTL_MS });
        deployFinished = isDeployExecType(row.type);
      }
      const terminal = to === 'done' || to === 'failed' || to === 'rejected';
      await m.query(
        `UPDATE commands
            SET status = $2, acked_at = COALESCE(acked_at, now()), result = COALESCE($3::jsonb, result),
                error_code = $4, error_message = $5, finished_at = CASE WHEN $6 THEN now() ELSE finished_at END
          WHERE id = $1`,
        [p.commandId, to, result ? JSON.stringify(result) : null, error?.code ?? null, error ? error.message.slice(0, 500) : null, terminal],
      );
      if (summary && row.project_id && row.day) {
        await m.query(
          `INSERT INTO daily_summaries (project_id, day, part, summary, scores, model, command_id, created_at)
           VALUES ($1, $2::date, $7, $3, $4::jsonb, $5, $6, now())
           ON CONFLICT (project_id, day, part) DO UPDATE
             SET summary = EXCLUDED.summary, scores = EXCLUDED.scores, model = EXCLUDED.model, command_id = EXCLUDED.command_id, created_at = now()`,
          [row.project_id, row.day, summary.summary, JSON.stringify(summary.scores), summary.model, p.commandId, row.part ?? ''],
        );
      }
      if (to === 'done' && row.type === 'session.start' && p.result?.claudeSessionId) {
        // Hook'dan SessionStart odatda bir necha soniya keyin keladi: qator hali yo'q bo'lishi mumkin,
        // shuning uchun upsert — buyruq darhol sessiyaga bog'lanadi va `bg/remote` belgisi yo'qolmaydi
        await m.query(
          `INSERT INTO sessions (machine_id, claude_session_id, cwd, project, kind, started_by, status, model,
                                 permission_mode, started_at, status_since, last_seen_at)
           SELECT $1, $2, c.payload->>'cwd', regexp_replace(c.payload->>'cwd', '^.*[/\\\\]', ''), 'bg', 'remote', 'idle',
                  c.payload->>'model', c.payload->>'permissionMode', now(), now(), now()
             FROM commands c WHERE c.id = $3
           ON CONFLICT (machine_id, claude_session_id) DO UPDATE SET kind = 'bg', started_by = 'remote'`,
          [machineId, p.result.claudeSessionId, p.commandId],
        );
      }
      const rc = p.result?.remoteControl;
      if (to === 'done' && rc && (row.type === 'session.start' || row.type === 'session.remote_control')) {
        // 3.10: pane/sessiya faylidan tasdiqlangan holat (faqat RC holat qatori: nom va claude.ai/code havolasi). Natijada nom yo'q = allaqachon
        // yoniq edi (agent nomni bilmaydi): oldingi ma'lum nom va `since` saqlanadi.
        await m.query(
          `UPDATE sessions s
              SET remote_control = jsonb_build_object(
                    'enabled', $3::boolean,
                    'name', CASE WHEN $3::boolean THEN COALESCE($4::text, s.remote_control->>'name') ELSE NULL END,
                    'since', CASE WHEN (s.remote_control->>'enabled')::boolean IS NOT DISTINCT FROM $3::boolean THEN COALESCE(s.remote_control->>'since', $5::text) ELSE $5::text END,
                    'url', CASE WHEN $3::boolean THEN $6::text ELSE NULL END)
             FROM commands c
            WHERE c.id = $2 AND s.machine_id = $1 AND s.claude_session_id = COALESCE(c.payload->>'claudeSessionId', $7::text)`,
          [machineId, p.commandId, rc.enabled, rc.name ?? null, new Date().toISOString(), rc.url ?? null, p.result?.claudeSessionId ?? null],
        );
      }
      if (to === 'done' && row.type === 'session.resume') {
        // 6.14: agentd tmux ichida SHU sessiya (nusxa emas) tirik ekanini tasdiqladi: qator yoziladi/yangilanadi. Hook SessionStart
        // keyinroq keladi; shu orada kind=tmux (control-logic: prompt/stop), 'ended' emas. Heartbeat kind'ni qayta tasdiqlaydi.
        await m.query(
          `UPDATE sessions s SET kind = 'tmux', status = 'idle', status_since = now(), ended_at = NULL, end_reason = NULL,
                  last_seen_at = now(), stale_since = NULL
             FROM commands c
            WHERE c.id = $2 AND s.machine_id = $1 AND s.claude_session_id = c.payload->>'claudeSessionId'
              AND c.payload->>'claudeSessionId' = $3::text`,
          [machineId, p.commandId, p.result?.claudeSessionId ?? ''],
        );
      }
      if (to === 'done' && row.type === 'session.prompt') {
        // stop+resume: sessiya aniq tirik (agentd uni uyg'otdi); yangi SessionStart kechiksa ham 'ended' qolmasin
        await m.query(
          `UPDATE sessions s SET status = 'working', status_since = now(), ended_at = NULL, end_reason = NULL,
                  last_seen_at = now(), stale_since = NULL
             FROM commands c
            WHERE c.id = $2 AND s.machine_id = $1 AND s.claude_session_id = c.payload->>'claudeSessionId'`,
          [machineId, p.commandId],
        );
      }
      await this.audit.record(
        {
          actorKind: 'agentd',
          action: 'command.result',
          target: p.commandId,
          details: { type: row.type, state: to, machine_id: machineId, reason: error?.code ?? null, claude_session_id: p.result?.claudeSessionId ?? null },
        },
        m,
      );
      return { to, claudeSessionId: p.result?.claudeSessionId ?? null, projectId: summary || isGitCommandType(row.type) ? row.project_id : null, gitNotice, deployFinished };
    });
    if (!res) return;
    this.bus.publish({ type: 'command.changed', commandId: p.commandId });
    if (res.projectId) this.bus.publish({ type: 'project.changed', projectId: res.projectId });
    if (res.gitNotice) void gitNotifications.emit({ kind: 'ci_failed', notice: res.gitNotice });
    if (res.deployFinished) void deployNotifications.emit({ kind: 'finished', commandId: p.commandId });
    if (res.claudeSessionId) this.bus.publish({ type: 'sessions.changed', refs: [{ machineId, claudeSessionId: res.claudeSessionId }] });
  }

  // --- o'qish ----------------------------------------------------------------------------------

  async getDto(id: string): Promise<CommandDto> {
    const rows: CommandRow[] = await this.dataSource.query(`${SELECT_DTO} WHERE c.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'not_found', message: 'Command not found' });
    return toCommandDto(rows[0]);
  }

  async list(q: ListCommandsQuery): Promise<ListCommandsResponse> {
    const rows: CommandRow[] = await this.dataSource.query(
      `${SELECT_DTO}
        WHERE ($1::uuid IS NULL OR c.machine_id = $1)
          AND ($2::uuid IS NULL OR c.session_id = $2
               OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = $2 AND s.machine_id = c.machine_id
                          AND s.claude_session_id = COALESCE(c.payload->>'claudeSessionId', c.result->>'claudeSessionId')))
          AND ($3::text IS NULL OR c.status = $3)
        ORDER BY c.created_at DESC, c.id DESC LIMIT $4`,
      [q.machine ?? null, q.session ?? null, q.status ?? null, q.limit],
    );
    return { items: rows.map((r) => toCommandDto(r)) };
  }

  async listForSession(sessionId: string, limit = 50): Promise<ListCommandsResponse> {
    const exists: unknown[] = await this.dataSource.query(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId]);
    if (exists.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    return this.list({ session: sessionId, limit });
  }

  // --- dispatch --------------------------------------------------------------------------------

  /** `pending -> sent` (audit bilan BIR tranzaksiyada), keyin imzolab yuboradi. Audit yozilmasa yuborilmaydi. */
  private async dispatchCommand(id: string, body: DispatchBody, actor: CommandActor): Promise<void> {
    if ((await this.lockdown.state()).enabled) {
      await this.fail(id, 'lockdown', 'Lockdown is active', actor.actorKind, 'rejected');
      return;
    }
    const nonce = newDispatchNonce();
    const expiresAt = Date.now() + COMMAND_LIMITS.dispatchTtlMs;
    let machineId = '';
    const ok = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: CommandState; machine_id: string; type: CommandType }> = await m.query(`SELECT status, machine_id, type FROM commands WHERE id = $1 FOR UPDATE`, [id]);
      const row = rows[0];
      if (!row || row.status !== 'pending') return false;
      machineId = row.machine_id;
      await m.query(`UPDATE commands SET status = 'sent', sent_at = now(), dispatch_nonce = $2, expires_at = $3 WHERE id = $1`, [id, nonce, new Date(expiresAt)]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'command.dispatched', target: id, ip: actor.ip, details: { type: row.type, machine_id: row.machine_id } }, m);
      return true;
    });
    this.secrets.delete(id);
    if (!ok) return;
    this.bus.publish({ type: 'command.changed', commandId: id });

    const deviceId = this.dispatch.deviceIdFor(machineId);
    if (!deviceId) {
      await this.fail(id, 'machine_offline', 'The machine went offline before the command could be sent', 'system');
      return;
    }
    // Katta mazmun (3.7): bo'laklar dispatchdan oldin shu ulanishga (tartib saqlanadi)
    for (const c of body.chunks ?? []) {
      if (!this.dispatch.send(machineId, 'config.chunk', c)) {
        await this.fail(id, 'machine_offline', 'The machine went offline before the command could be sent', 'system');
        return;
      }
    }
    // 5.7 (H-02): imzo host imzolovchidan so'raladi. Yetib bo'lmasa/rad etsa buyruq YUBORILMAYDI (fail-closed), aniq xato kodi bilan.
    let sig: string;
    try {
      sig = await this.signer.sign({ deviceId, commandId: id, type: body.type, nonce, expiresAt, payloadSha256: hashCommandPayload(body.payload) });
    } catch (err) {
      const code = err instanceof SignerRejectedError ? `signer_${err.signerCode}` : 'signer_unavailable';
      this.logger.error(`command ${id} not sent: signer ${code}`);
      await this.fail(id, code, 'The command signer did not sign the command; it was not sent to the machine', 'system');
      return;
    }
    const sent = this.dispatch.send(machineId, 'command.dispatch', { commandId: id, type: body.type, payload: body.payload, nonce, expiresAt, sig });
    if (!sent) await this.fail(id, 'machine_offline', 'The machine went offline before the command could be sent', 'system');
  }

  // --- muddat ----------------------------------------------------------------------------------

  async sweep(now: Date = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      for (const [id, s] of this.secrets) if (s.until < now.getTime()) this.secrets.delete(id);
      for (const [id, t] of this.transient) if (t.until < now.getTime()) this.transient.delete(id);
      for (const [id, t] of this.configTransient) if (t.until < now.getTime()) this.configTransient.delete(id);
      for (const [id, t] of this.gitTransient) if (t.until < now.getTime()) this.gitTransient.delete(id);
      for (const [id, t] of this.repoTransient) if (t.until < now.getTime()) this.repoTransient.delete(id);
      const changed = await this.dataSource.transaction(async (m) => {
        const rows: Array<{ id: string; status: CommandState; type: CommandType }> = await m.query(
          `SELECT id, status, type FROM commands
            WHERE (status IN ('awaiting_confirmation', 'sent') AND expires_at <= $1)
               OR (status IN ('acked', 'running') AND acked_at IS NOT NULL
                   AND acked_at + (CASE type WHEN 'session.start' THEN interval '90 seconds' WHEN 'session.prompt' THEN interval '120 seconds'
                                             WHEN 'project.summarize' THEN interval '150 seconds' WHEN 'project.read_md' THEN interval '30 seconds'
                                             WHEN 'project.append_tasks' THEN interval '30 seconds' WHEN 'config.capture' THEN interval '40 seconds'
                                             WHEN 'assistant.ask' THEN interval '120 seconds' WHEN 'project.diff' THEN interval '45 seconds' WHEN 'project.open_pr' THEN interval '120 seconds' WHEN 'deploy.run' THEN interval '130 minutes' WHEN 'deploy.rollback' THEN interval '130 minutes' WHEN 'deploy.inspect' THEN interval '45 seconds' WHEN 'git.checkpoint_restore' THEN interval '90 seconds' WHEN 'project.scan' THEN interval '330 seconds' WHEN 'session.remote_control' THEN interval '150 seconds' ELSE interval '60 seconds' END) <= $1)
            FOR UPDATE`,
          [now],
        );
        for (const r of rows) {
          if (r.status === 'awaiting_confirmation') await this.finish(m, r.id, 'expired', 'step_up_expired', 'The confirmation window has passed', null, 'command.expired');
          else if (r.status === 'sent') await this.finish(m, r.id, 'expired', 'dispatch_expired', 'The agent did not acknowledge the command in time', null, 'command.expired');
          else await this.finish(m, r.id, 'failed', 'agent_timeout', 'The agent did not report a result in time', null, 'command.timeout');
        }
        return rows.map((r) => r.id);
      });
      for (const id of changed) {
        this.secrets.delete(id);
        this.bus.publish({ type: 'command.changed', commandId: id });
      }
      return changed.length;
    } finally {
      this.sweeping = false;
    }
  }

  // --- ichki -----------------------------------------------------------------------------------

  private async failStranded(): Promise<void> {
    const rows: Array<{ id: string }> = await this.dataSource.query(`SELECT id FROM commands WHERE status IN ('awaiting_confirmation', 'pending')`);
    for (const r of rows) await this.fail(r.id, 'center_restarted', 'The center restarted before the command was dispatched', 'system');
  }

  private async fail(id: string, code: string, message: string, actorKind: AuditActorKind, to: 'failed' | 'rejected' = 'failed'): Promise<void> {
    const changed = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ status: CommandState }> = await m.query(`SELECT status FROM commands WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0] || ['done', 'failed', 'expired', 'rejected'].includes(rows[0].status)) return false;
      await this.finish(m, id, to, code, message, null, `command.${to}`, actorKind);
      return true;
    });
    this.secrets.delete(id);
    if (changed) this.bus.publish({ type: 'command.changed', commandId: id });
  }

  /** Yakuniy holat + audit (chaqiruvchi tranzaksiyasi ichida, qator qulflangan bo'lishi kerak). */
  private async finish(
    m: EntityManager,
    id: string,
    to: CommandState,
    code: string,
    message: string,
    actor: CommandActor | null,
    action: string,
    actorKind: AuditActorKind = 'system',
  ): Promise<void> {
    await m.query(`UPDATE commands SET status = $2, error_code = $3, error_message = $4, finished_at = now() WHERE id = $1`, [id, to, code, message.slice(0, 500)]);
    await this.audit.record({ actorDeviceId: actor?.deviceId ?? null, actorKind: actor?.actorKind ?? actorKind, action, target: id, ip: actor?.ip ?? null, details: { reason: code } }, m);
  }

  private async lockOwn(m: EntityManager, id: string, machineId: string): Promise<{ status: CommandState; type: CommandType; project_id: string | null; day: string | null; part: string | null }> {
    const rows: Array<{ status: CommandState; type: CommandType; machine_id: string; project_id: string | null; day: string | null; part: string | null }> = await m.query(
      `SELECT status, type, machine_id, project_id, payload->>'day' AS day, payload->>'part' AS part FROM commands WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row || row.machine_id !== machineId) throw new CommandRejectedError('unknown command for this machine');
    return row;
  }

  private async findIdempotent(deviceId: string, key: string, hash: string): Promise<CommandDto | null> {
    const rows: Array<{ id: string; request_hash: string | null }> = await this.dataSource.query(
      `SELECT id, request_hash FROM commands WHERE requested_by_device_id = $1 AND nonce = $2`,
      [deviceId, key],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.request_hash !== hash) throw new ConflictException({ error: 'idempotency_conflict', message: 'This Idempotency-Key was already used with a different request body' });
    return this.getDto(row.id);
  }

  private async resolveTarget(body: AnyCommandBody): Promise<Target> {
    if ('projectId' in body) {
      const rows: Array<{ project_id: string; machine_id: string; path: string; online: boolean; control: AgentControlState | null; os: string | null; slug: string }> = await this.dataSource.query(
        `SELECT p.id AS project_id, p.machine_id, p.path, m.online, m.control, m.os, m.slug
           FROM projects p JOIN machines m ON m.id = p.machine_id
          WHERE p.id = $1 AND m.status = 'active' AND m.merged_into_id IS NULL`,
        [body.projectId],
      );
      const p = rows[0];
      if (!p) throw new NotFoundException({ error: 'not_found', message: 'Project not found' });
      return { machineId: p.machine_id, machineOnline: p.online, control: p.control, machineOs: p.os, session: null, sessionUuid: null, projectId: p.project_id, projectRoot: p.path, machineSlug: p.slug };
    }
    if (body.type === 'session.start' || body.type === 'assistant.ask' || body.type === 'config.capture' || body.type === 'config.apply' || body.type === 'config.rollback' || body.type === 'logs.tail') {
      const rows: Array<{ id: string; online: boolean; control: AgentControlState | null; os: string | null }> = await this.dataSource.query(
        `SELECT id, online, control, os FROM machines WHERE id = $1 AND status = 'active' AND merged_into_id IS NULL`,
        [body.machineId],
      );
      const m = rows[0];
      if (!m) throw new NotFoundException({ error: 'not_found', message: 'Machine not found' });
      return { machineId: m.id, machineOnline: m.online, control: m.control, machineOs: m.os, session: null, sessionUuid: null, projectId: null, projectRoot: null };
    }
    const rows: Array<{ id: string; machine_id: string; claude_session_id: string; kind: string; cwd: string | null; ended_at: Date | null; status: string; online: boolean; control: AgentControlState | null; os: string | null }> =
      await this.dataSource.query(
        `SELECT s.id, s.machine_id, s.claude_session_id, s.kind, s.cwd, s.ended_at, s.status, m.online, m.control, m.os
           FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.id = $1`,
        [body.sessionId],
      );
    const s = rows[0];
    if (!s) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    return {
      machineId: s.machine_id,
      machineOnline: s.online,
      control: s.control,
      machineOs: s.os,
      sessionUuid: s.id,
      session: { kind: s.kind, ended: s.ended_at !== null || s.status === 'ended', claudeSessionId: s.claude_session_id, cwd: s.cwd },
      projectId: null,
      projectRoot: null,
    };
  }

  private buildSecret(body: AnyCommandBody, target: Target): DispatchBody {
    const claudeSessionId = target.session?.claudeSessionId ?? null;
    const root = target.projectRoot ?? '';
    switch (body.type) {
      case 'session.start':
        return {
          type: 'session.start',
          payload: {
            cwd: body.cwd,
            prompt: body.prompt,
            permissionMode: body.permissionMode,
            ...(body.model ? { model: body.model } : {}),
            ...(body.name ? { name: body.name } : {}),
            ...(body.remoteControl ? { remoteControl: true } : {}),
          },
        };
      case 'session.remote_control':
        return { type: 'session.remote_control', payload: { claudeSessionId: claudeSessionId ?? '', enable: body.enable, ...(body.enable && body.name ? { name: body.name } : {}) } };
      case 'session.resume':
        // cwd markaz DB'sidan (mijoz bermaydi); precheck cwd yo'q bo'lsa allaqachon rad etgan
        return { type: 'session.resume', payload: { claudeSessionId: claudeSessionId ?? '', cwd: target.session?.cwd ?? '' } };
      case 'session.close':
        return { type: 'session.close', payload: { claudeSessionId: claudeSessionId ?? '' } };
      case 'session.prompt':
        return { type: 'session.prompt', payload: { claudeSessionId: claudeSessionId ?? '', text: body.text } };
      case 'session.stop':
        return { type: 'session.stop', payload: { claudeSessionId: claudeSessionId ?? '' } };
      case 'session.set_mode':
        return { type: 'session.set_mode', payload: { claudeSessionId: claudeSessionId ?? '', permissionMode: body.permissionMode } };
      case 'project.refresh':
        return { type: 'project.refresh', payload: { root } };
      case 'project.read_md':
        return { type: 'project.read_md', payload: { root, path: body.path } };
      case 'project.append_tasks':
        return {
          type: 'project.append_tasks',
          payload: { root, tasksPath: body.tasksPath, baseHash: body.baseHash, phase: body.phase, tasks: body.tasks.map((t) => ({ key: t.key, title: t.title, ...(t.size ? { size: t.size } : {}) })) },
        };
      case 'project.summarize':
        return { type: 'project.summarize', payload: { root, input: body.input } };
      case 'assistant.ask':
        return { type: 'assistant.ask', payload: { question: body.question, context: body.context } };
      case 'config.capture':
        return { type: 'config.capture', payload: { includeSettings: true } };
      case 'config.apply':
        return { type: 'config.apply', payload: body.apply, chunks: body.chunks };
      case 'config.rollback':
        return { type: 'config.rollback', payload: { backupId: body.backupId } };
      case 'project.diff':
        return { type: 'project.diff', payload: { root, ...(body.base ? { base: body.base } : {}), ...(body.maxBytes ? { maxBytes: body.maxBytes } : {}), ...(body.statOnly ? { statOnly: true } : {}) } };
      case 'project.open_pr':
        return { type: 'project.open_pr', payload: { root, title: body.title, body: body.body, base: body.base, draft: body.draft, ...(body.head ? { head: body.head } : {}) } };
      case 'project.ci_status':
        return { type: 'project.ci_status', payload: { root, ...(body.branch ? { branch: body.branch } : {}) } };
      case 'project.scan':
        return { type: 'project.scan', payload: { root } };
      case 'deploy.inspect':
      case 'deploy.run':
      case 'deploy.rollback':
      case 'git.checkpoint':
      case 'git.checkpoint_list':
      case 'git.checkpoint_restore':
        return repoSecret(body, root, target.machineSlug ?? '') as unknown as DispatchBody;
      case 'logs.tail':
        return { type: 'logs.tail', payload: { source: body.source, name: body.name, lines: body.lines, ...(body.since ? { since: body.since } : {}), ...(body.follow ? { follow: true } : {}) } };
    }
  }

  /** Redakt qilingan, DB'ga yoziladigan nusxa (haqiqiy prompt matni YO'Q). */
  private storedPayload(body: AnyCommandBody, target: Target, notes: readonly string[] = []): Record<string, unknown> {
    const claudeSessionId = target.session?.claudeSessionId ?? null;
    switch (body.type) {
      case 'session.start':
        return {
          cwd: body.cwd,
          permissionMode: body.permissionMode,
          ...(body.model ? { model: body.model } : {}),
          ...(body.name ? { name: body.name } : {}),
          ...(body.remoteControl ? { remoteControl: true } : {}),
          promptLength: body.prompt.length,
          promptRedacted: redactAndCap(body.prompt, STORED_PROMPT_CHARS),
          ...reviewField(reviewForPrompt(body.prompt), notes),
        };
      case 'session.prompt':
        return { claudeSessionId, promptLength: body.text.length, promptRedacted: redactAndCap(body.text, STORED_PROMPT_CHARS), ...reviewField(reviewForPrompt(body.text), notes) };
      case 'session.stop':
      case 'session.close':
        return { claudeSessionId };
      case 'session.set_mode':
        return { claudeSessionId, permissionMode: body.permissionMode };
      case 'session.remote_control':
        return { claudeSessionId, enable: body.enable, ...(body.enable && body.name ? { name: body.name } : {}) };
      case 'session.resume':
        // step-up kartasida ko'rinadi (promptRedacted): nima tasdiqlanayotgani aniq; claude session id qisqartirilgan
        return { claudeSessionId, cwd: target.session?.cwd ?? null, promptLength: 0, promptRedacted: redactAndCap(`Davom ettirish: terminal sessiya ${String(claudeSessionId).slice(0, 8)} yangi tmux sessiyada (claude --resume)`, 300) };
      case 'project.refresh':
        return { projectId: body.projectId, cwd: target.projectRoot };
      case 'project.read_md':
        return { projectId: body.projectId, cwd: target.projectRoot, path: body.path };
      case 'project.append_tasks': {
        // Step-up xabarida ko'rinadigan reja: "id sarlavha" qatorlari (redakt qilingan)
        const lines = body.tasks.map((t) => `${t.key} ${t.title}${t.size ? ` [${t.size}]` : ''}`).join('\n');
        return {
          projectId: body.projectId,
          cwd: target.projectRoot,
          phase: redactAndCap(body.phase, 200),
          tasksPath: body.tasksPath,
          taskKeys: body.tasks.map((t) => t.key),
          promptLength: body.tasks.length,
          promptRedacted: redactAndCap(lines, STORED_PROMPT_CHARS),
        };
      }
      case 'assistant.ask':
        return { promptLength: body.question.length, contextChars: body.context.length, promptRedacted: redactAndCap(body.question, STORED_PROMPT_CHARS) };
      case 'config.capture':
        return { promptLength: 0, promptRedacted: 'Sozlamalarni mashinadan olish (capture)' };
      case 'config.apply':
        return {
          profileId: body.profileId,
          profileName: body.apply.profileName,
          profileVersion: body.apply.profileVersion,
          mode: body.apply.mode,
          dryRun: body.apply.dryRun,
          itemCount: body.apply.items.length,
          planHash: body.apply.expectedPlanHash ?? null,
          promptLength: body.preview.length,
          promptRedacted: redactAndCap(body.preview, STORED_PROMPT_CHARS),
          ...(body.review ? { review: { required: body.review.required, reasons: body.review.reasons.slice(0, 16).map((r) => r.slice(0, 300)) } } : {}),
        };
      case 'config.rollback':
        return { backupId: body.backupId, promptLength: body.backupId.length, promptRedacted: `Zaxiradan qaytarish: ${body.backupId}` };
      case 'project.summarize':
        return { projectId: body.projectId, cwd: target.projectRoot, day: body.input.day, ...(body.part ? { part: body.part } : {}), taskCount: body.input.tasks.length, commitCount: body.input.commitSubjects.length };
      case 'project.diff':
        return { projectId: body.projectId, cwd: target.projectRoot, base: body.base ?? 'HEAD', statOnly: body.statOnly === true };
      case 'project.open_pr': {
        // Step-up xabarida ko'rinadigan reja: sarlavha + base <- head (redakt qilingan); tana matni DB'ga tushmaydi
        const title = redactAndCap(body.title, 256);
        return {
          projectId: body.projectId,
          cwd: target.projectRoot,
          title,
          base: body.base,
          ...(body.head ? { head: body.head } : {}),
          draft: body.draft,
          promptLength: body.body.length,
          promptRedacted: `${title}\n${body.head ?? 'HEAD'} -> ${body.base}${body.draft ? ' (draft)' : ''}`,
        };
      }
      case 'project.ci_status':
        return { projectId: body.projectId, cwd: target.projectRoot, ...(body.branch ? { branch: body.branch } : {}) };
      case 'project.scan':
        return { projectId: body.projectId, cwd: target.projectRoot };
      case 'deploy.inspect':
      case 'deploy.run':
      case 'deploy.rollback':
      case 'git.checkpoint':
      case 'git.checkpoint_list':
      case 'git.checkpoint_restore':
        return repoStoredPayload(body, target.projectRoot, body.type === 'deploy.run' || body.type === 'deploy.rollback' ? deployReview(body.plan ?? '', notes) : undefined);
      case 'logs.tail':
        // Log matni HECH QAYERDA saqlanmaydi: faqat manba turi/nomi (qisqa tavsif step-up/ro'yxat uchun)
        return {
          source: body.source,
          name: body.name,
          lines: body.lines,
          ...(body.since ? { since: body.since } : {}),
          ...(body.follow ? { follow: true } : {}),
          promptLength: body.lines,
          promptRedacted: redactAndCap(`${body.source}: ${body.name} (${body.lines} qator${body.follow ? ', jonli' : ''})`, 300),
        };
    }
  }

  private async insert(
    m: EntityManager,
    a: { body: AnyCommandBody; actor: CommandActor; key: string; requestHash: string; target: Target; rejection: CommandRejection | null; stepUp: boolean; inlineConfirmed: boolean; now: Date },
  ): Promise<string> {
    const { body, actor, target, rejection } = a;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`commands:${target.machineId}`]);
    if (!rejection) {
      const [{ n }] = (await m.query(`SELECT count(*)::int AS n FROM commands WHERE machine_id = $1 AND status IN ${OPEN_STATES}`, [target.machineId])) as Array<{ n: number }>;
      if (n >= COMMAND_LIMITS.maxOpenPerMachine) throw new ConflictException({ error: 'too_many_open_commands', message: 'Too many open commands on this machine' });
      if (target.sessionUuid && body.type !== 'session.stop') {
        const busy: unknown[] = await m.query(`SELECT 1 FROM commands WHERE session_id = $1 AND status IN ${OPEN_STATES} AND type <> 'session.stop' LIMIT 1`, [target.sessionUuid]);
        if (busy.length > 0) throw new ConflictException({ error: 'command_in_flight', message: 'Another command for this session is still in progress' });
      }
      if (target.projectId && (body.type === 'project.append_tasks' || body.type === 'project.summarize' || body.type === 'project.open_pr')) {
        // Bir loyihada bir vaqtda bitta yozish/xulosa: ikki marta bosish ikki marta qo'shmasin
        const busy: unknown[] = await m.query(`SELECT 1 FROM commands WHERE project_id = $1 AND type = $2 AND status IN ${OPEN_STATES} LIMIT 1`, [target.projectId, body.type]);
        if (busy.length > 0) throw new ConflictException({ error: 'command_in_flight', message: 'Another command of this type for this project is still in progress' });
      }
    }
    if (!rejection && target.projectId && (body.type === 'deploy.run' || body.type === 'deploy.rollback')) {
      // Bir maqsad uchun bir vaqtda bitta deploy/rollback (tasdiq kutayotgani ham ushlab turadi: ikki marta bosish ikki deploy bo'lmasin)
      const busy: unknown[] = await m.query(
        `SELECT 1 FROM commands WHERE project_id = $1 AND type IN ('deploy.run', 'deploy.rollback') AND payload->>'target' = $2 AND status IN ${OPEN_STATES} LIMIT 1`,
        [target.projectId, body.target],
      );
      if (busy.length > 0) throw new ConflictException({ error: 'deploy_busy', message: 'A deploy or rollback for this target is already in progress' });
    }
    const status: CommandState = rejection ? 'rejected' : a.stepUp ? 'awaiting_confirmation' : 'pending';
    const inline = a.inlineConfirmed && !rejection;
    const ttl = a.stepUp ? COMMAND_LIMITS.stepUpTtlMs : COMMAND_LIMITS.dispatchTtlMs;
    const rows: Array<{ id: string }> = await m.query(
      `INSERT INTO commands
         (type, machine_id, session_id, project_id, payload, status, requested_by_device_id, nonce, request_hash, expires_at,
          step_up_required, error_code, error_message, finished_at, confirmed_by_device_id, confirmed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        body.type,
        target.machineId,
        target.sessionUuid,
        target.projectId,
        JSON.stringify(this.storedPayload(body, target, actor.reviewNotes)),
        status,
        actor.deviceId,
        a.key,
        a.requestHash,
        new Date(a.now.getTime() + ttl),
        a.stepUp,
        rejection?.code ?? null,
        rejection?.message ?? null,
        rejection ? a.now : null,
        inline ? actor.deviceId : null,
        inline ? a.now : null,
      ],
    );
    const id = rows[0]!.id;
    await this.audit.record(
      {
        actorDeviceId: actor.deviceId,
        actorKind: actor.actorKind,
        action: 'command.created',
        target: id,
        ip: actor.ip,
        details: {
          type: body.type,
          machine_id: target.machineId,
          session_id: target.sessionUuid,
          ...(target.projectId ? { project_id: target.projectId } : {}),
          status,
          step_up: a.stepUp,
          ...(inline ? { confirmation: actor.confirmation } : {}),
          reason: rejection?.code ?? null,
          prompt_length: 'prompt' in body ? body.prompt.length : 'text' in body ? body.text.length : null,
          ...(body.type === 'project.append_tasks' ? { task_keys: body.tasks.map((t) => t.key), phase_length: body.phase.length } : {}),
          ...(body.type === 'project.read_md' ? { path: body.path } : {}),
          ...(body.type === 'session.remote_control' ? { enable: body.enable } : {}),
          ...(body.type === 'session.resume' ? { claude_session_id: target.session?.claudeSessionId ?? null } : {}),
          ...(body.type === 'session.start' && body.remoteControl ? { remote_control: true } : {}),
          ...(body.type === 'project.summarize' ? { day: body.input.day, ...(body.part ? { part: body.part } : {}) } : {}),
          ...(body.type === 'project.diff' ? { base: body.base ?? 'HEAD', stat_only: body.statOnly === true } : {}),
          ...(body.type === 'project.open_pr' ? { base: body.base, head: body.head ?? null, draft: body.draft, title_length: body.title.length, body_length: body.body.length } : {}),
          ...(body.type === 'project.ci_status' ? { branch: body.branch ?? null } : {}),
          ...(isDeployCommandType(body.type) || isCheckpointCommandType(body.type) ? repoAuditDetails(body as DeployCommandBody | CheckpointCommandBody) : {}),
          ...(body.type === 'logs.tail' ? { source: body.source, name: body.name.slice(0, 200), lines: body.lines, follow: body.follow === true, since: body.since ?? null } : {}),
        },
      },
      m,
    );
    if (inline) {
      // Chat ichidagi aniq tasdiq (xulosa kartasi): `command.confirmed` yozuvi dispatchdan oldin, qator bilan atomik.
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'command.confirmed', target: id, ip: actor.ip, details: { type: body.type, confirmation: actor.confirmation } },
        m,
      );
    }
    return id;
  }

  // --- loyiha buyruqlari uchun yordamchilar ----------------------------------------------------

  /** Buyruq yakuniy holatga yetguncha kutadi (polling, 200 ms). Muddat tugasa joriy holat qaytadi (`timedOut`). */
  async waitFinished(id: string, timeoutMs: number): Promise<{ command: CommandDto; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const dto = await this.getDto(id);
      if (dto.status === 'done' || dto.status === 'failed' || dto.status === 'expired' || dto.status === 'rejected') return { command: dto, timedOut: false };
      if (Date.now() >= deadline) return { command: dto, timedOut: true };
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** `project.diff` natijasi (3.5; bir marta olinadi, xotiradan o'chadi). */
  takeDiff(id: string): DiffResult | null {
    const t = this.gitTransient.get(id);
    this.gitTransient.delete(id);
    return t && t.until >= Date.now() ? t.diff : null;
  }

  /** `project.read_md` natijasi (bir marta olinadi, xotiradan o'chadi). */
  /** `config.*` natijasi (bir marta olinadi, xotiradan o'chadi). */
  takeConfig(id: string): unknown {
    const t = this.configTransient.get(id);
    this.configTransient.delete(id);
    return t && t.until >= Date.now() ? t.config : undefined;
  }

  /** `assistant.ask` natijasi (bir marta olinadi, xotiradan o'chadi). */
  takeAssistant(id: string): unknown {
    const t = this.assistantTransient.get(id);
    this.assistantTransient.delete(id);
    return t && t.until >= Date.now() ? t.value : undefined;
  }

  /** `deploy.inspect` / `git.checkpoint*` natijasi (bir marta olinadi, xotiradan o'chadi). */
  takeRepoResult(id: string): unknown {
    const t = this.repoTransient.get(id);
    this.repoTransient.delete(id);
    return t && t.until >= Date.now() ? t.value : undefined;
  }

  /** Deploy agentda qabul qilindi (`acked`): Telegram "boshlandi" xabari uchun (xato bildirishni buzmaydi). */
  private async notifyDeployStarted(commandId: string): Promise<void> {
    try {
      const rows: Array<{ type: string }> = await this.dataSource.query(`SELECT type FROM commands WHERE id = $1`, [commandId]);
      if (rows[0] && isDeployExecType(rows[0].type)) await deployNotifications.emit({ kind: 'started', commandId });
    } catch (err) {
      this.logger.warn(`deploy start notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  takeMd(id: string): ReadMdResult | null {
    const t = this.transient.get(id);
    this.transient.delete(id);
    return t && t.until >= Date.now() ? t.md : null;
  }
}

interface Target {
  machineId: string;
  machineOnline: boolean;
  control: AgentControlState | null;
  machineOs: string | null;
  sessionUuid: string | null;
  session: { kind: string; ended: boolean; claudeSessionId: string; cwd: string | null } | null;
  projectId: string | null;
  projectRoot: string | null;
  /** Loyiha buyruqlari uchun mashina slug'i (deploy payload'idagi `machine`). */
  machineSlug?: string | null;
}
