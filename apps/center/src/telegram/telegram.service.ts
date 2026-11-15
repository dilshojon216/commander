import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Context } from 'grammy';
import { APPROVAL_LIMITS, ListSessionsQuerySchema, PLAN_REMOTE_APPROVE_SUPPORTED, RULE_EDIT_TOOLS } from '@commander/contracts';
import type { ApprovalBehavior, ApprovalDto, AskAnswer, CommandDto, CreateCommandBody, SessionDto } from '@commander/contracts';
import { MachinesService } from '../api/machines.service.js';
import { SessionsV1Service } from '../api/sessions-v1.service.js';
import { UsageService } from '../api/usage.service.js';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { StepUpRegistry } from '../commands/step-up.js';
import { QUESTION_LIMITS } from '@commander/contracts';
import { applyEvent, decodeOptionArg, flowAnswers, newFlow, questionButtons } from './telegram-question.js';
import type { QuestionFlow } from './telegram-question.js';
import { ApprovalRulesService } from '../approvals/approval-rules.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { decideForecastAlert } from '../limits/forecast-logic.js';
import { LimitsService } from '../limits/limits.service.js';
import { QueueService } from '../queue/queue.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { nextCronRun } from '../queue/cron.js';
import { formatForecastAlert, formatQueueList, formatQueued, queueErrorTextUz } from './queue-telegram-format.js';
import { formatResumeCloseResult } from './resume-format.js';
import { MAX_TEMPLATE_BUTTONS, RC_CONFIRM_TOAST, TEMPLATE_TOO_LONG_TEXT, formatRcResult, formatTemplateMissing, formatTemplatePicker, templateButtonLabel } from './template-rc-format.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import type { DomainEvent } from '../realtime/realtime-bus.js';
import { redactAndCap } from '../common/redact-text.js';
import { telegramExtensions } from './telegram-extensions.js';
import { INVESTIGATE_BUTTON_TTL_MS, telegramInvestigations } from './telegram-investigate.js';
import { buildPrDefaults } from '@commander/contracts';
import { callbackKey, decodeCallback, encodeCallback } from './callback-data.js';
import type { CallbackAction } from './callback-data.js';
import { DoneNoticeScheduler, MachineWatch, SessionNoticeGate, decideLimitAlerts, type SessionNoticeKind } from './notify-logic.js';
import { DEFAULT_PREFS, TelegramAccessService } from './telegram-access.service.js';
import type { TelegramPrefs } from './telegram-access.service.js';
import {
  HELP_TEXT,
  fmtTime,
  approvalRequiresDashboard,
  formatApproval,
  formatCommandStepUp,
  formatLimitAlert,
  formatLimits,
  formatMachineOffline,
  formatMachineOnline,
  formatSessionNotice,
  formatSessionQuestion,
  escapeHtml,
  formatStatus,
  formatUsage,
  truncate,
} from './telegram-format.js';
import { TELEGRAM_BOT, TELEGRAM_OPTIONS } from './telegram.options.js';
import type { TelegramOptions } from './telegram.options.js';
import {
  FLOW_TTL_MS,
  FlowStore,
  MAX_FOLDERS,
  MODELS,
  MODE_LABELS,
  PickRegistry,
  RateGate,
  TARGET_TTL_MS,
  availableModes,
  isStartable,
  parseSessionArg,
  parseTypedPath,
  validTaskText,
} from './new-flow.js';
import type { Flow, FlowStage, PickValue, ReplyTarget } from './new-flow.js';
import { GitOpsService } from '../projects/git-ops.service.js';
import { gitNotifications } from '../projects/git-notify.js';
import { deployNotifications } from '../deploy/deploy-notify.js';
import type { DeployNotice } from '../deploy/deploy-notify.js';
import { DeployService } from '../deploy/deploy.service.js';
import { beforeStartHooks } from '../commands/before-start.js';
import { deployErrorTextUz, formatDeployFinished, formatDeployStarted, formatRollbackCard } from './telegram-deploy.js';
import type { CiFailureNotice } from '../projects/git-notify.js';
import { formatCiFailure, formatDiffStat, formatPrCard, formatPrProgress, gitErrorTextUz } from './telegram-git.js';
import {
  FLOW_EXPIRED_TEXT,
  LOCKDOWN_TEXT,
  NO_MACHINES_TEXT,
  PATH_PROMPT_TEXT,
  RATE_LIMITED_TEXT,
  TASK_PROMPT_TEXT,
  commandErrorTextUz,
  formatAutoConfirm,
  formatFlowCancelled,
  formatFolderPicker,
  formatMachinePicker,
  formatModePicker,
  formatModelPicker,
  formatNewProgress,
  formatPathError,
  formatSessionCard,
  formatSessionList,
  flowRequiresDashboard,
  formatSummary,
  formatTaskError,
  formatWaiting,
} from './new-flow-format.js';
import type { FolderItem } from './new-flow-format.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
const MAX_TRACKED_APPROVALS = 200;
const MAX_LISTED_APPROVALS = 10;
const MAX_MUTE_MINUTES = 24 * 60;
const REJECT_AUDIT_GAP_MS = 10 * 60_000;
const DENY_MESSAGE = 'Telegram orqali rad etildi';
/** Avto-ruxsat tugmasi: shu sessiyada Edit/Write 1 soat (2.13). */
const RULE_BUTTON_TTL_SECONDS = 3600;
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PLAN_FEEDBACK_PROMPT = '✏️ Reja uchun fikringizni shu xabarga javob (reply) sifatida yozing: Claude rejani qayta ko\'rib chiqadi.';
const MAX_PLAN_TARGETS = 300;
const QUESTION_OTHER_PROMPT = '✍️ Javobingizni shu xabarga javob (reply) sifatida yozing.';
const MAX_QUESTION_FLOWS = 200;
const MAX_REPLY_TARGETS = 500;
const MAX_PROGRESS = 200;
/** Deploy xabaridagi "Rollback" tugmasi amal qilish muddati. */
const DEPLOY_BUTTON_TTL_MS = 6 * 60 * 60_000;
/** Telegram'dan PR ochishda base branch (default). Boshqasi kerak bo'lsa dashboard'dan. */
const GIT_PR_DEFAULT_BASE = 'main';

interface ProgressEntry {
  chatId: string;
  messageId: number;
  kind: 'start' | 'prompt' | 'stop';
  machineName: string;
}

type Submitted = { ok: true; dto: CommandDto } | { ok: false; text: string };
type Answer = (text?: string, alert?: boolean) => Promise<void>;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Telegram bot (1.8): center ichidagi modul, grammY long polling (inbound port/webhook yo'q).
 *
 * Xavfsizlik:
 *  - FAQAT allowlist'dagi shaxsiy chat (`chat.id === from.id`) javob oladi; qolganlar jim tashlanadi
 *    (/start yuborganlar `telegram pending` uchun eslab qolinadi, hech kim avtomatik allow qilinmaydi);
 *  - qarorlar `ApprovalsService.decide()` orqali, `telegram` identity (alohida device qatori) bilan: audit,
 *    lockdown (allow rad, deny ruxsat) va "birinchi qaror yutadi" qoidalari HTTP yo'li bilan bir xil;
 *  - callback_data HMAC bilan imzolangan, har callbackda allowlist qayta tekshiriladi, approval holati serverda;
 *  - "Ruxsat" ikki bosqichli (ask -> confirm); xabarlarga tool kiritmasi redakt qilingan va 300 belgigacha;
 *  - Telegram API xatosi center'ga ta'sir qilmaydi (barcha chaqiruvlar ushlanadi, polling o'zi qayta urinadi).
 */
@Injectable()
export class TelegramService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TelegramService.name);
  private readonly key: Buffer | null;
  private readonly gate: SessionNoticeGate;
  private readonly doneNotices = new DoneNoticeScheduler();
  private readonly watch: MachineWatch;
  private readonly machineNames = new Map<string, string>();
  private readonly approvalMessages = new Map<string, Map<string, number>>();
  private readonly notifiedBatches = new Set<string>();
  private readonly rejectedAuditAt = new Map<string, number>();
  /** Step-up xabarlari: commandId -> chatId -> messageId (xotirada; tasdiq oynasi 2 daqiqa). */
  private readonly commandMessages = new Map<string, Map<string, number>>();
  /** `/new` (2.x Telegram'dan ochish): suhbat holati, tugma havolalari, tezlik chegarasi, progress va reply nishonlari (hammasi xotirada). */
  private readonly flows = new FlowStore(FLOW_TTL_MS);
  private readonly picks = new PickRegistry();
  private readonly newRate = new RateGate();
  private readonly progress = new Map<string, ProgressEntry>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  /** Reja so'rovi xabarlari (va fikr so'rovi xabari): `chatId:messageId` -> approvalId. Reply = fikr bilan rad (2.14). Xotirada. */
  private readonly planTargets = new Map<string, string>();
  /** AskUserQuestion (6.13): approvalId -> ketma-ket javob holati (xotirada; restartdan keyin savol qaytadan boshlanadi). */
  private readonly questionFlows = new Map<string, QuestionFlow>();
  /** "Boshqa…" so'rovi xabari: `chatId:messageId` -> {approvalId, savol}. Reply = erkin matn javobi. */
  private readonly otherTargets = new Map<string, { approvalId: string; q: number }>();
  private unregisterStepUp: (() => void) | null = null;
  private prefs: TelegramPrefs = { ...DEFAULT_PREFS, limitAlerts: {} };
  private prefsChain: Promise<unknown> = Promise.resolve();
  private limitsChain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeGit: (() => void) | null = null;
  private unsubscribeDeploy: (() => void) | null = null;
  /** Deploy bildirishnomalari (6.5): bir (tur, buyruq) uchun BIR marta. */
  private readonly deployNoticed = new Set<string>();
  /** PR ochish buyruqlari kuzatuvi (3.5): commandId -> karta xabari (xotirada). */
  private readonly gitProgress = new Map<string, { chatId: string; messageId: number }>();
  private machineTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private polling: Promise<void> | null = null;
  /** Polling kuzatuvi (5.5): oxirgi muvaffaqiyatli `getUpdates` va polling boshlangan vaqt. */
  private pollStartedAt: number | null = null;
  private lastPollOkAt: number | null = null;

  constructor(
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
    @Inject(TELEGRAM_BOT) private readonly bot: Bot | null,
    private readonly access: TelegramAccessService,
    private readonly approvals: ApprovalsService,
    private readonly machines: MachinesService,
    private readonly sessions: SessionsV1Service,
    private readonly usage: UsageService,
    private readonly limits: LimitsService,
    private readonly lockdown: LockdownService,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    private readonly commands: CommandsService,
    private readonly stepUp: StepUpRegistry,
    private readonly rules: ApprovalRulesService,
    /** Sessiyalararo xabar (2.10): `question` turidagi xabar haqida ixtiyoriy bildirishnoma. Testlarda berilmaydi. */
    @Optional() private readonly messaging?: MessagingService,
    /** Vazifalar navbati (3.1): yo'q bo'lsa `/queue` va `/new` ichidagi navbat variantlari o'chiq. */
    @Optional() private readonly queue?: QueueService,
    /** Prompt shablonlari (3.4): yo'q bo'lsa `/new` da "Shablondan" bosqichi ko'rinmaydi. Testlarda berilmaydi. */
    @Optional() private readonly templates?: TemplatesService,
    /** Git/PR (3.5): sessiya tugagach Diff / PR ochish tugmalari, CI xatosi bildirishnomasi. Testlarda berilmaydi. */
    @Optional() private readonly git?: GitOpsService,
    /** Deploy (6.5): tugagan deploy xabarida "Rollback" tugmasi (chat ichidagi tasdiq). Testlarda berilmaydi. */
    @Optional() private readonly deployApi?: DeployService,
  ) {
    this.key = options.token ? callbackKey(options.token) : null;
    this.gate = new SessionNoticeGate(options.sessionMinGapMs);
    this.watch = new MachineWatch(Date.now(), options.machineGraceMs, options.machineOfflineAfterMs);
  }

  // --- hayot tsikli ----------------------------------------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bot || !this.key) {
      this.logger.log('Telegram bot disabled (TELEGRAM_BOT_TOKEN is not set)');
      return;
    }
    this.registerHandlers(this.bot);
    this.unsubscribe = this.bus.subscribe((e) => this.onEvent(e));
    this.unsubscribeGit = gitNotifications.subscribe((n) => (n.kind === 'ci_failed' ? this.onCiFailed(n.notice) : undefined));
    this.unsubscribeDeploy = deployNotifications.subscribe((n) => this.onDeployNotice(n));
    // Step-up kanali (2.7): faqat bot haqiqatan polling qilayotgan bo'lsa.
    if (this.options.polling) this.unregisterStepUp = this.stepUp.register({ isAvailable: () => this.stepUpAvailable(), request: (c) => this.requestStepUp(c) });
    this.machineTimer = setInterval(() => void this.checkMachines().catch((err: unknown) => this.logger.error(`machine check failed: ${errMessage(err)}`)), this.options.machineTickMs);
    this.machineTimer.unref();
    await this.seed();
    if (this.options.polling) {
      this.pollStartedAt = Date.now();
      // Markaz o'z-o'zini kuzatishi (5.5): polling "qotib qolgan"ini aniqlash uchun har muvaffaqiyatli getUpdates vaqti.
      this.bot.api.config.use(async (prev, method, payload, signal) => {
        const res = await prev(method, payload, signal);
        if (method === 'getUpdates' && res.ok) this.lastPollOkAt = Date.now();
        return res;
      });
      this.polling = this.pollLoop();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeGit?.();
    this.unsubscribeGit = null;
    this.unsubscribeDeploy?.();
    this.unsubscribeDeploy = null;
    this.unregisterStepUp?.();
    this.unregisterStepUp = null;
    if (this.machineTimer) clearInterval(this.machineTimer);
    this.machineTimer = null;
    this.doneNotices.clearAll();
    if (this.bot && this.polling) {
      await Promise.race([this.bot.stop().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 3000).unref())]);
    }
  }

  /** `enabled=false`: bot/polling o'chiq (kuzatuv hodisa ochmaydi). */
  pollingStats(): { enabled: boolean; startedAt: number | null; lastOkAt: number | null } {
    return { enabled: !!this.bot && this.options.polling && this.pollStartedAt !== null, startedAt: this.pollStartedAt, lastOkAt: this.lastPollOkAt };
  }

  /** Token log/xatolarga tushmasin. */
  private scrub(msg: string): string {
    let out = msg.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[bot-token]');
    if (this.options.token) out = out.replaceAll(this.options.token, '[bot-token]');
    return out;
  }

  private warn(what: string, err: unknown): void {
    this.logger.warn(`${what}: ${this.scrub(errMessage(err))}`);
  }

  private async seed(): Promise<void> {
    try {
      this.prefs = await this.access.loadPrefs();
    } catch (err) {
      this.warn('prefs load failed (defaults)', err);
    }
    try {
      const now = Date.now();
      for (const m of (await this.machines.list()).items) {
        this.machineNames.set(m.id, m.displayName ?? m.hostname ?? m.slug);
        this.watch.observe(m.id, m.online, now);
      }
      const active = await this.sessions.list(ListSessionsQuerySchema.parse({ active: '1', limit: '500' }));
      for (const s of active.items) this.gate.seed(s.id, s.status);
    } catch (err) {
      this.warn('seed failed', err);
    }
  }

  /** Long polling. Tarmoq xatosida eksponensial kutish bilan qayta urinadi; 401 (yaroqsiz token) da to'xtaydi. */
  private async pollLoop(): Promise<void> {
    const bot = this.bot!;
    let delay = 2000;
    while (!this.stopping) {
      try {
        await bot.start({
          allowed_updates: ['message', 'callback_query'],
          onStart: (me) => {
            delay = 2000;
            this.logger.log(`Telegram polling started (@${me.username})`);
            void bot.api
              .setMyCommands([
                { command: 'status', description: 'Mashinalar va sessiyalar' },
                { command: 'usage', description: 'Token sarfi' },
                { command: 'limits', description: 'Limitlar' },
                { command: 'approvals', description: 'Kutayotgan ruxsatlar' },
                { command: 'new', description: 'Yangi Claude sessiyasi ochish' },
                { command: 'queue', description: 'Vazifalar navbati' },
                { command: 'budget', description: 'Kunlik byudjet' },
                { command: 'orch', description: 'Orkestratsiyalar holati' },
                { command: 'p', description: 'Loyiha qismlari progressi' },
                { command: 's', description: 'Sessiya holati' },
                { command: 'mute', description: 'Xabarlarni vaqtincha o\'chirish' },
                { command: 'notify', description: 'Tugadi xabarlari on/off' },
                { command: 'help', description: 'Yordam' },
              ])
              .catch((err: unknown) => this.warn('setMyCommands failed', err));
          },
        });
        return;
      } catch (err) {
        if (this.stopping) return;
        if (err instanceof GrammyError && err.error_code === 401) {
          this.logger.error('Telegram rejected the bot token (401): bot stopped');
          return;
        }
        this.warn(`Telegram polling failed, retry in ${delay / 1000}s`, err);
        await new Promise<void>((r) => setTimeout(r, delay).unref());
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  // --- handlerlar ------------------------------------------------------------------------------

  private registerHandlers(bot: Bot): void {
    bot.catch((err) => this.logger.error(`handler failed: ${this.scrub(errMessage(err.error))}`));

    // Darvoza: allowlist (har update, shu jumladan har callback, qayta tekshiriladi).
    bot.use(async (ctx, next) => {
      const chat = ctx.chat;
      const from = ctx.from;
      if (chat?.type === 'private' && from !== undefined && from.id === chat.id && (await this.access.isAllowed(chat.id))) {
        await next();
        return;
      }
      await this.rejected(ctx);
    });

    bot.command(['start', 'help'], (ctx) => this.reply(ctx, HELP_TEXT));
    bot.command('status', (ctx) => this.cmdStatus(ctx));
    bot.command('usage', (ctx) => this.cmdUsage(ctx));
    bot.command('limits', (ctx) => this.cmdLimits(ctx));
    bot.command('approvals', (ctx) => this.cmdApprovals(ctx));
    bot.command('mute', (ctx) => this.cmdMute(ctx));
    bot.command('notify', (ctx) => this.cmdNotify(ctx));
    bot.command('new', (ctx) => this.cmdNew(ctx));
    bot.command('cancel', (ctx) => this.cmdCancel(ctx));
    bot.command('s', (ctx) => this.cmdSession(ctx));
    bot.command('queue', (ctx) => this.cmdQueue(ctx));
    bot.command('report', (ctx) => this.cmdExtension(ctx, 'report'));
    bot.command('orch', (ctx) => this.cmdExtension(ctx, 'orch'));
    bot.command('logs', (ctx) => this.cmdExtension(ctx, 'logs'));
    bot.command('find', (ctx) => this.cmdExtension(ctx, 'find'));
    bot.command('ask', (ctx) => this.cmdExtension(ctx, 'ask'));
    bot.command('budget', (ctx) => this.cmdExtension(ctx, 'budget'));
    bot.command('p', (ctx) => this.cmdExtension(ctx, 'p'));
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** Allowlist'da yo'q: JIM. Faqat /start eslab qolinadi (pairing) va audit (kam: chatga 10 daqiqada bir). */
  private async rejected(ctx: Context): Promise<void> {
    try {
      const chat = ctx.chat;
      const text = ctx.message?.text;
      if (chat?.type === 'private' && ctx.from && text !== undefined && /^\/start(@\w+)?(\s|$)/.test(text)) {
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
        await this.access.recordPending({ chatId: String(chat.id), username: ctx.from.username ?? null, name: name || null });
      }
      const idKey = String(chat?.id ?? ctx.from?.id ?? 'unknown');
      const now = Date.now();
      const last = this.rejectedAuditAt.get(idKey);
      if (last === undefined || now - last >= REJECT_AUDIT_GAP_MS) {
        if (this.rejectedAuditAt.size > 500) this.rejectedAuditAt.clear();
        this.rejectedAuditAt.set(idKey, now);
        await this.audit.record({
          actorKind: 'system',
          action: 'telegram.rejected',
          target: idKey,
          details: { chat_id: idKey, from_id: ctx.from?.id ?? null, chat_type: chat?.type ?? null, update: ctx.callbackQuery ? 'callback_query' : 'message' },
        });
      }
    } catch (err) {
      this.warn('reject bookkeeping failed', err);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined); // matnsiz: spinner to'xtaydi, javob yo'q
  }

  private async reply(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    await ctx.reply(text, { ...HTML, ...extra });
  }

  private async cmdStatus(ctx: Context): Promise<void> {
    const [machines, approvals] = await Promise.all([this.machines.list(), this.approvals.list({ recentLimit: 0 })]);
    await this.reply(ctx, formatStatus(machines, approvals.pending.length));
  }

  private async cmdUsage(ctx: Context): Promise<void> {
    const [summary, projects] = await Promise.all([this.usage.summary(), this.usage.projects({ limit: 200 })]);
    await this.reply(ctx, formatUsage(summary, projects));
  }

  /** Boshqa modullar (`telegramExtensions`) ro'yxatdan o'tkazgan buyruq (3.3 `/report`). Allowlist middleware'dan keyin keladi. */
  private async cmdExtension(ctx: Context, name: string): Promise<void> {
    const handler = telegramExtensions.get(name);
    if (!handler) {
      await this.reply(ctx, 'Bu buyruq hozir mavjud emas.');
      return;
    }
    const args = (ctx.message?.text ?? '').replace(/^\/\w+(@\w+)?\s*/, '').trim();
    try {
      for (const part of await handler(args, String(ctx.chat!.id))) await this.reply(ctx, part);
    } catch (err) {
      this.warn(`/${name} failed`, err);
      await this.reply(ctx, 'Buyruq bajarilmadi. Keyinroq urinib ko\'ring.');
    }
  }

  /**
   * Allowlist'dagi barcha chatlarga HTML xabar (3.2 watchdog, 3.3 hisobot). `stopSessionId` berilsa "To'xtatish" tugmasi
   * (mavjud ikki bosqichli stop oqimi: tasdiq + buyruq konveyeri). Yetkazilgan chatlar soni (bot o'chiq = 0). Mute'ga bo'ysunmaydi.
   */
  async notifyText(text: string, opts: { stopSessionId?: string; investigate?: { kind: 'health' | 'watchdog'; id: string } } = {}): Promise<number> {
    if (!this.bot || !this.key) return 0;
    const stopId = opts.stopSessionId;
    const inv = opts.investigate;
    const markup = (chatId: string): InlineKeyboard => {
      let kb = stopId ? this.stopKb(chatId, { sessionId: stopId, commandId: null }) : this.newKb();
      // 6.4: hodisa/ogohlantirish xabarida "🔍 Claude tekshirsin" (ikki bosqich: karta, keyin chat ichidagi tasdiq)
      if (inv && telegramInvestigations.get()) kb = this.pickBtn(stopId ? kb.row() : kb, chatId, '🔍 Claude tekshirsin', { kind: 'inv_ask', subject: inv.kind, id: inv.id }, null, INVESTIGATE_BUTTON_TTL_MS);
      return kb;
    };
    const sent = await this.send(text, stopId || inv ? markup : undefined);
    return sent.length;
  }

  /**
   * Fayllarni (masalan 6.8 mijoz hisoboti) FAQAT egasi chatlariga (allowlist) yuboradi. Mijozga hech qachon. Hech bir chatga
   * yetmasa 0 (bot o'chiq, allowlist bo'sh); yetkazilgan chatlar soni qaytadi (har chatga hamma fayl yetgan bo'lsa).
   */
  async notifyDocuments(files: ReadonlyArray<{ filename: string; data: Buffer }>, caption: string): Promise<number> {
    if (!this.bot || !this.key) return 0;
    let delivered = 0;
    for (const chatId of await this.access.allowedIds()) {
      try {
        for (const [i, f] of files.entries()) {
          await this.bot.api.sendDocument(chatId, new InputFile(f.data, f.filename), i === 0 ? { caption } : {});
        }
        delivered++;
      } catch (err) {
        this.warn(`sendDocument failed (chat ${chatId})`, err);
      }
    }
    return delivered;
  }

  private async cmdLimits(ctx: Context): Promise<void> {
    await this.reply(ctx, formatLimits(await this.limits.current()));
  }

  private async cmdApprovals(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const { pending } = await this.approvals.list({ recentLimit: 0 });
    if (pending.length === 0) {
      await this.reply(ctx, 'Kutayotgan ruxsat so\'rovi yo\'q.');
      return;
    }
    const lockdown = (await this.lockdown.state()).enabled;
    for (const a of pending.slice(0, MAX_LISTED_APPROVALS)) {
      const sent = await ctx.reply(this.fmt(a, lockdown), { ...HTML, reply_markup: this.mainKeyboard(a, chatId, lockdown) });
      this.trackMessage(a.id, String(chatId), sent.message_id, a.kind);
    }
    if (pending.length > MAX_LISTED_APPROVALS) await this.reply(ctx, `Yana ${pending.length - MAX_LISTED_APPROVALS} ta so'rov bor (dashboard'da ko'ring).`);
  }

  private async cmdMute(ctx: Context): Promise<void> {
    const arg = (typeof ctx.match === 'string' ? ctx.match : '').trim().toLowerCase();
    if (arg === '0' || arg === 'off') {
      await this.updatePrefs((p) => ({ ...p, mutedUntil: 0 }));
      await this.reply(ctx, '🔔 Sessiya xabarlari yoqildi.');
      return;
    }
    const minutes = /^\d{1,4}$/.test(arg) ? Number(arg) : NaN;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MUTE_MINUTES) {
      const now = Date.now();
      const state = this.prefs.mutedUntil > now ? `Hozir ${fmtTime(new Date(this.prefs.mutedUntil))} gacha o'chirilgan.` : 'Hozir o\'chirilmagan.';
      await this.reply(ctx, `Foydalanish: /mute &lt;daqiqa 1-${MAX_MUTE_MINUTES}&gt; yoki /mute 0\n${state}`);
      return;
    }
    const until = Date.now() + minutes * 60_000;
    await this.updatePrefs((p) => ({ ...p, mutedUntil: until }));
    await this.reply(ctx, `🔕 Sessiya xabarlari ${fmtTime(new Date(until))} gacha o'chirildi (ruxsat so'rovlari baribir keladi).`);
  }

  private async cmdNotify(ctx: Context): Promise<void> {
    const [what, value] = (typeof ctx.match === 'string' ? ctx.match : '').trim().toLowerCase().split(/\s+/);
    if (what !== 'done' || (value !== 'on' && value !== 'off')) {
      await this.reply(ctx, `Foydalanish: /notify done on|off\n"Sessiya tugadi" xabarlari hozir: <b>${this.prefs.notifyDone ? 'on' : 'off'}</b>`);
      return;
    }
    await this.updatePrefs((p) => ({ ...p, notifyDone: value === 'on' }));
    await this.reply(ctx, `"Sessiya tugadi" xabarlari: <b>${value}</b>`);
  }

  // --- callback (approval tugmalari) -----------------------------------------------------------

  private async onCallback(ctx: Context): Promise<void> {
    let answered = false;
    const answer = async (text?: string, alert = false): Promise<void> => {
      if (answered) return;
      answered = true;
      await ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined).catch((err: unknown) => this.warn('answerCallbackQuery failed', err));
    };
    try {
      const chatId = ctx.chat!.id;
      const message = ctx.callbackQuery?.message;
      const decoded = this.key && ctx.callbackQuery?.data ? decodeCallback(this.key, ctx.callbackQuery.data, chatId) : null;
      if (!decoded || !message) {
        await answer('Noto\'g\'ri so\'rov');
        return;
      }
      if (decoded.action === 'pick') await this.handlePick(String(chatId), decoded.approvalId, message.message_id, answer);
      else if (decoded.action === 'cmdyes' || decoded.action === 'cmdno') await this.handleCommandAction(decoded.action, decoded.approvalId, String(chatId), message.message_id, answer);
      else await this.handleAction(decoded.action, decoded.approvalId, String(chatId), message.message_id, answer, decoded.arg ?? '');
    } catch (err) {
      this.logger.error(`callback failed: ${this.scrub(errMessage(err))}`);
      await answer('Xatolik, qayta urinib ko\'ring', true);
    } finally {
      await answer(); // har doim javob beriladi
    }
  }

  private async handleAction(
    action: CallbackAction,
    approvalId: string,
    chatId: string,
    messageId: number,
    answer: (text?: string, alert?: boolean) => Promise<void>,
    arg = '',
  ): Promise<void> {
    let dto: ApprovalDto;
    try {
      dto = await this.approvals.getDto(approvalId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        await answer('So\'rov topilmadi', true);
        return;
      }
      throw err;
    }
    const lockdown = (await this.lockdown.state()).enabled;

    if (dto.status !== 'pending') {
      await answer('Allaqachon hal qilingan', true);
      await this.editApproval(chatId, messageId, dto, lockdown);
      return;
    }
    if (action === 'back') {
      await this.editMarkup(chatId, messageId, this.mainKeyboard(dto, chatId, lockdown));
      await answer();
      return;
    }
    if (action === 'fb') {
      await this.askPlanFeedback(dto, chatId, answer);
      return;
    }
    if (action === 'qopt' || action === 'qsubmit' || action === 'qother') {
      await this.handleQuestionAction(action, dto, arg, chatId, messageId, lockdown, answer);
      return;
    }
    if (action === 'rule' || action === 'ruleyes') {
      await this.handleRuleAction(action, dto, chatId, messageId, lockdown, answer);
      return;
    }
    if (action === 'ask') {
      if (approvalRequiresDashboard(dto)) {
        await answer("Bu so'rovni faqat dashboard'da to'liq ko'rib tasdiqlash mumkin", true);
        await this.editApproval(chatId, messageId, dto, lockdown);
        return;
      }
      if (lockdown) {
        await answer('Lockdown: faqat rad etish mumkin', true);
        await this.editApproval(chatId, messageId, dto, lockdown);
        return;
      }
      await this.editMarkup(chatId, messageId, this.confirmKeyboard(approvalId, chatId));
      await answer('Tasdiqlang');
      return;
    }
    await this.decide(approvalId, action === 'deny' ? 'deny' : 'allow', chatId, messageId, answer);
  }

  private async decide(
    approvalId: string,
    behavior: ApprovalBehavior,
    chatId: string,
    messageId: number,
    answer: (text?: string, alert?: boolean) => Promise<void>,
    feedback?: string,
    answers?: AskAnswer[],
  ): Promise<void> {
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    if (behavior === 'allow' && approvalRequiresDashboard(await this.approvals.getDto(approvalId))) {
      await answer("Bu so'rovni faqat dashboard'da to'liq ko'rib tasdiqlash mumkin", true);
      return;
    }
    try {
      const res = await this.approvals.decide(approvalId, { behavior, ...(behavior === 'deny' ? { message: feedback ?? DENY_MESSAGE } : {}), ...(answers ? { answers } : {}) }, { deviceId, actorKind: 'telegram', ip: null });
      this.questionFlows.delete(approvalId);
      await answer(behavior === 'allow' ? (answers ? '✅ Javob yuborildi' : '✅ Ruxsat berildi') : '❌ Rad etildi');
      if (messageId > 0) await this.editApproval(chatId, messageId, res.approval, false);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        await answer('Lockdown: faqat rad etish mumkin', true);
        await this.editMarkup(chatId, messageId, this.mainKeyboard(await this.approvals.getDto(approvalId), chatId, true));
        return;
      }
      if (err instanceof UnprocessableEntityException) {
        await answer(answers ? 'Javob qabul qilinmadi: dashboard\'da javob bering' : 'Reja terminalda tasdiqlanadi (masofadan tasdiqlab bo\'lmaydi)', true);
        return;
      }
      if (err instanceof ConflictException) {
        await answer('Allaqachon hal qilingan', true);
        await this.refreshMessage(approvalId, chatId, messageId);
        return;
      }
      if (err instanceof NotFoundException) {
        await answer('So\'rov topilmadi', true);
        return;
      }
      throw err;
    }
  }

  // --- avto-ruxsat qoidasi tugmasi (2.13) va reja fikri (2.14) -----------------------------------

  /** Tugma faqat fayl yozish vositalari, sessiyasi ma'lum oddiy so'rov uchun (Bash va boshqalarga YO'Q). */
  private ruleButtonApplies(dto: Pick<ApprovalDto, 'kind' | 'toolName' | 'sessionId'>): boolean {
    return dto.kind === 'tool' && dto.sessionId !== null && FILE_EDIT_TOOLS.has(dto.toolName);
  }

  /** `rule`: tasdiq so'rovi; `ruleyes`: qoida yaratiladi (inline tasdiq = Telegram tasdig'i) va shu so'rov allow qilinadi. */
  private async handleRuleAction(action: 'rule' | 'ruleyes', dto: ApprovalDto, chatId: string, messageId: number, lockdown: boolean, answer: Answer): Promise<void> {
    if (lockdown) {
      await answer('Lockdown: qoida yaratib bo\'lmaydi', true);
      return;
    }
    if (!this.ruleButtonApplies(dto)) {
      await answer('Bu so\'rov uchun avto-ruxsat mumkin emas', true);
      return;
    }
    if (action === 'rule') {
      await this.editMarkup(chatId, messageId, this.ruleConfirmKeyboard(dto.id, chatId));
      await answer('Tasdiqlang');
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    try {
      await this.rules.create(
        { scope: 'session', scopeRef: dto.sessionId!, tools: [...RULE_EDIT_TOOLS], pathGlobs: [], ttlSeconds: RULE_BUTTON_TTL_SECONDS },
        { deviceId, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' },
      );
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException || err instanceof ConflictException) {
        await answer('Qoida yaratilmadi', true);
        return;
      }
      throw err;
    }
    // Shu so'rov ham ruxsat oladi (foydalanuvchi aynan shuni tanladi); xatolar `decide` ichida javob beriladi.
    await this.decide(dto.id, 'allow', chatId, messageId, answer);
  }

  private ruleConfirmKeyboard(approvalId: string, chatId: string | number): InlineKeyboard {
    const key = this.key!;
    return new InlineKeyboard()
      .text('✅ Ha: ruxsat + 1 soat qoida', encodeCallback(key, 'ruleyes', approvalId, chatId))
      .text('↩️ Orqaga', encodeCallback(key, 'back', approvalId, chatId));
  }

  /** "Fikr bilan rad": ForceReply so'rovi yuboriladi; javob matni `deny` izohi bo'ladi (onText). */
  private async askPlanFeedback(dto: ApprovalDto, chatId: string, answer: Answer): Promise<void> {
    if (dto.kind !== 'plan') {
      await answer('Bu so\'rov reja emas', true);
      return;
    }
    const id = await this.sendForceReply(chatId, PLAN_FEEDBACK_PROMPT, 'Fikringiz (reja haqida)');
    if (id !== null) this.setPlanTarget(chatId, id, dto.id);
    await answer('Fikringizni yozing');
  }

  private setPlanTarget(chatId: string, messageId: number, approvalId: string): void {
    const k = `${chatId}:${messageId}`;
    this.planTargets.delete(k);
    this.planTargets.set(k, approvalId);
    if (this.planTargets.size > MAX_PLAN_TARGETS) {
      const oldest = this.planTargets.keys().next().value;
      if (oldest !== undefined) this.planTargets.delete(oldest);
    }
  }

  /** Reja xabariga (yoki fikr so'roviga) reply: matn `deny` izohi (<= 1000 belgi); sir bo'lsa redakt, kesish keyin. */
  private async handlePlanFeedback(ctx: Context, chatId: string, approvalId: string, raw: string): Promise<void> {
    const text = raw.trim();
    if (text.length === 0) return;
    const feedback = truncate(redactAndCap(text, APPROVAL_LIMITS.messageMaxChars * 4), APPROVAL_LIMITS.messageMaxChars);
    const answer: Answer = async (t) => {
      if (t) await this.reply(ctx, escapeHtml(t));
    };
    let dto: ApprovalDto;
    try {
      dto = await this.approvals.getDto(approvalId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        await this.reply(ctx, "So'rov topilmadi");
        return;
      }
      throw err;
    }
    if (dto.status !== 'pending' || dto.kind !== 'plan') {
      await this.reply(ctx, 'Allaqachon hal qilingan: fikr yuborilmadi.');
      return;
    }
    const msgs = this.approvalMessages.get(approvalId);
    const planMessageId = msgs?.get(chatId);
    await this.decide(approvalId, 'deny', chatId, planMessageId ?? 0, answer, feedback);
    await this.reply(ctx, '✏️ Fikr yuborildi: Claude rejani qayta ko\'rib chiqadi.');
  }

  // --- AskUserQuestion javoblari (6.13) ----------------------------------------------------------

  private flowFor(dto: ApprovalDto): QuestionFlow {
    let flow = this.questionFlows.get(dto.id);
    if (!flow) {
      flow = newFlow(dto.questions?.length ?? 0);
      this.questionFlows.set(dto.id, flow);
      if (this.questionFlows.size > MAX_QUESTION_FLOWS) {
        const oldest = this.questionFlows.keys().next().value;
        if (oldest !== undefined) this.questionFlows.delete(oldest);
      }
    }
    return flow;
  }

  /** Variant/Yuborish/Boshqa… tugmalari. Hech narsa avtomatik tanlanmaydi; oxirgi savol javoblangach bitta `decide(allow, answers)`. */
  private async handleQuestionAction(action: 'qopt' | 'qsubmit' | 'qother', dto: ApprovalDto, arg: string, chatId: string, messageId: number, lockdown: boolean, answer: Answer): Promise<void> {
    if (dto.kind !== 'question' || !dto.questions) {
      await answer('Bu savol emas', true);
      return;
    }
    if (lockdown) {
      await answer('Lockdown: javob berib bo\'lmaydi, faqat rad etish mumkin', true);
      await this.editApproval(chatId, messageId, dto, lockdown);
      return;
    }
    const flow = this.flowFor(dto);
    if (action === 'qother') {
      if (Number(arg) !== flow.current) {
        await answer('Eski tugma', true);
        await this.editApproval(chatId, messageId, dto, lockdown);
        return;
      }
      const id = await this.sendForceReply(chatId, QUESTION_OTHER_PROMPT, 'Javobingiz');
      if (id !== null) this.setOtherTarget(chatId, id, dto.id, flow.current);
      await answer('Javobingizni yozing');
      return;
    }
    const opt = action === 'qopt' ? decodeOptionArg(arg) : null;
    const ev = action === 'qopt' ? (opt ? ({ kind: 'pick', q: opt.q, o: opt.o } as const) : null) : ({ kind: 'submit', q: Number(arg) } as const);
    if (!ev) {
      await answer('Noto\'g\'ri so\'rov', true);
      return;
    }
    const r = applyEvent(flow, dto.questions, ev);
    await this.afterQuestionEvent(r, dto, chatId, messageId, lockdown, answer);
  }

  private async afterQuestionEvent(r: ReturnType<typeof applyEvent>, dto: ApprovalDto, chatId: string, messageId: number, lockdown: boolean, answer: Answer): Promise<void> {
    if (r.status === 'stale') {
      await answer('Eski tugma', true);
      await this.editApproval(chatId, messageId, dto, lockdown);
      return;
    }
    if (r.status === 'empty') {
      await answer('Kamida bitta variantni belgilang', true);
      return;
    }
    this.questionFlows.set(dto.id, r.flow);
    if (r.status === 'done') {
      const answers = flowAnswers(r.flow, dto.questions ?? []);
      if (!answers) {
        this.questionFlows.delete(dto.id);
        await answer('Javoblar to\'liq emas: qaytadan boshlang', true);
        await this.editApproval(chatId, messageId, dto, lockdown);
        return;
      }
      await this.decide(dto.id, 'allow', chatId, messageId, answer, undefined, answers);
      return;
    }
    await this.editApproval(chatId, messageId, dto, lockdown);
    await answer(r.status === 'next' ? 'Keyingi savol' : undefined);
  }

  private setOtherTarget(chatId: string, messageId: number, approvalId: string, q: number): void {
    const k = `${chatId}:${messageId}`;
    this.otherTargets.delete(k);
    this.otherTargets.set(k, { approvalId, q });
    if (this.otherTargets.size > MAX_PLAN_TARGETS) {
      const oldest = this.otherTargets.keys().next().value;
      if (oldest !== undefined) this.otherTargets.delete(oldest);
    }
  }

  /** "Boshqa…" so'roviga reply: matn erkin javob (redakt qilinadi, <= 1000 belgi). */
  private async handleQuestionOther(ctx: Context, chatId: string, target: { approvalId: string; q: number }, raw: string): Promise<void> {
    const text = truncate(redactAndCap(raw.trim(), QUESTION_LIMITS.otherChars * 4), QUESTION_LIMITS.otherChars).trim();
    if (text.length === 0) return;
    const say: Answer = async (t) => {
      if (t) await this.reply(ctx, escapeHtml(t));
    };
    let dto: ApprovalDto;
    try {
      dto = await this.approvals.getDto(target.approvalId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        await this.reply(ctx, "So'rov topilmadi");
        return;
      }
      throw err;
    }
    if (dto.status !== 'pending' || dto.kind !== 'question' || !dto.questions) {
      await this.reply(ctx, 'Allaqachon hal qilingan: javob yuborilmadi.');
      return;
    }
    const lockdown = (await this.lockdown.state()).enabled;
    if (lockdown) {
      await this.reply(ctx, 'Lockdown: javob berib bo\'lmaydi, faqat rad etish mumkin.');
      return;
    }
    const r = applyEvent(this.flowFor(dto), dto.questions, { kind: 'other', q: target.q, text });
    const messageId = this.approvalMessages.get(target.approvalId)?.get(chatId) ?? 0;
    if (r.status === 'stale') {
      await this.reply(ctx, "Bu savol allaqachon o'tib ketgan.");
      return;
    }
    await this.afterQuestionEvent(r, dto, chatId, messageId, lockdown, say);
  }

  // --- step-up (buyruq tasdig'i) -----------------------------------------------------------------

  private async stepUpAvailable(): Promise<boolean> {
    return this.bot !== null && this.key !== null && !this.stopping && (await this.access.allowedIds()).size > 0;
  }

  private commandKeyboard(commandId: string, chatId: string | number, reviewRequired = false): InlineKeyboard {
    const key = this.key!;
    // H-06/H-04: to'liq ko'rib chiqish talab qilinsa Telegram'da "Tasdiqlash" YO'Q (dashboard'da tasdiqlanadi).
    const kb = new InlineKeyboard();
    if (!reviewRequired) kb.text('✅ Tasdiqlash', encodeCallback(key, 'cmdyes', commandId, chatId));
    return kb.text('❌ Bekor', encodeCallback(key, 'cmdno', commandId, chatId));
  }

  private async machineName(machineId: string): Promise<string> {
    const cached = this.machineNames.get(machineId);
    if (cached) return cached;
    const m = await this.machines.findById(machineId);
    const name = m ? (m.displayName ?? m.hostname ?? m.slug) : machineId;
    this.machineNames.set(machineId, name);
    return name;
  }

  /** Egasi chatlariga (allowlist) tasdiq so'rovi. Yetkazilgan chatlar soni; 0 = hech qayerga yetmadi. */
  private async requestStepUp(c: CommandDto): Promise<number> {
    if (!this.bot || !this.key) return 0;
    const text = formatCommandStepUp(c, await this.machineName(c.machineId));
    const sent = await this.send(text, (chatId) => this.commandKeyboard(c.id, chatId, c.review?.required === true));
    for (const s of sent) {
      const per = this.commandMessages.get(c.id) ?? new Map<string, number>();
      per.set(s.chatId, s.messageId);
      this.commandMessages.set(c.id, per);
    }
    if (this.commandMessages.size > MAX_TRACKED_APPROVALS) {
      const oldest = this.commandMessages.keys().next().value;
      if (oldest !== undefined) this.commandMessages.delete(oldest);
    }
    return sent.length;
  }

  private async handleCommandAction(
    action: 'cmdyes' | 'cmdno',
    commandId: string,
    chatId: string,
    messageId: number,
    answer: (text?: string, alert?: boolean) => Promise<void>,
  ): Promise<void> {
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    const actor: CommandActor = { deviceId, actorKind: 'telegram', ip: null };
    try {
      if (action === 'cmdno') {
        const r = await this.commands.cancel(commandId, actor);
        await answer(r.cancelled ? '❌ Bekor qilindi' : 'Allaqachon hal qilingan', !r.cancelled);
        await this.editCommand(chatId, messageId, r.command);
        return;
      }
      if ((await this.commands.getDto(commandId)).review?.required === true) {
        await answer("Bu buyruqni faqat dashboard'da to'liq ko'rib tasdiqlash mumkin", true);
        return;
      }
      const r = await this.commands.confirm(commandId, actor);
      const texts: Record<string, string> = {
        confirmed: '✅ Tasdiqlandi',
        not_pending: 'Allaqachon hal qilingan',
        expired: 'Tasdiq muddati o\'tgan',
        same_device: 'So\'rovchi qurilma o\'zini tasdiqlay olmaydi',
        lockdown: 'Lockdown: buyruq rad etildi',
        lost: 'Buyruq ma\'lumoti yo\'qolgan (qayta yarating)',
      };
      await answer(texts[r.outcome] ?? r.outcome, r.outcome !== 'confirmed');
      await this.editCommand(chatId, messageId, r.command);
    } catch (err) {
      if (err instanceof NotFoundException) {
        await answer('Buyruq topilmadi', true);
        return;
      }
      throw err;
    }
  }

  private async editCommand(chatId: string, messageId: number, c: CommandDto): Promise<void> {
    try {
      await this.bot!.api.editMessageText(chatId, messageId, formatCommandStepUp(c, await this.machineName(c.machineId)), {
        ...HTML,
        reply_markup: c.status === 'awaiting_confirmation' ? this.commandKeyboard(c.id, chatId, c.review?.required === true) : { inline_keyboard: [] },
      });
    } catch (err) {
      if (!this.isNotModified(err)) this.warn('editMessageText (command) failed', err);
    }
  }

  private async onCommandChanged(commandId: string): Promise<void> {
    if (this.progress.has(commandId)) await this.renderProgress(commandId);
    if (this.gitProgress.has(commandId)) await this.renderGitProgress(commandId);
    const msgs = this.commandMessages.get(commandId);
    if (!msgs) return;
    const dto = await this.commands.getDto(commandId);
    if (dto.status === 'awaiting_confirmation') return;
    // Yakuniy holatgacha (done/failed/...) xabar yangilanadi; oraliq holatlarda ham matn yangilanadi, tugmalar olinadi.
    for (const [chatId, messageId] of msgs) await this.editCommand(chatId, messageId, dto);
    if (['done', 'failed', 'expired', 'rejected'].includes(dto.status)) this.commandMessages.delete(commandId);
  }

  private async refreshMessage(approvalId: string, chatId: string, messageId: number): Promise<void> {
    try {
      const dto = await this.approvals.getDto(approvalId);
      await this.editApproval(chatId, messageId, dto, (await this.lockdown.state()).enabled);
    } catch (err) {
      this.warn('message refresh failed', err);
    }
  }

  // --- /new: Telegram'dan sessiya ochish (chat ichida tasdiq), /s, reply-prompt, stop ------------------
  //
  // Step-up qarori: "Ochish" tugmasi (yakuniy xulosa kartasi) = Telegram tasdig'i. Shu sabab buyruq `confirmation: 'telegram_inline'`
  // bilan yaratiladi va markaz ikkinchi Telegram so'rovi YUBORMAYDI (audit: `confirmation=telegram_inline`). Boshqa joydan
  // (dashboard boshqa qurilma, API) boshlangan buyruqlar uchun qoida o'zgarmagan. `auto` rejim chatda alohida ikkinchi tugma bilan tasdiqlanadi.

  private newKb(): InlineKeyboard {
    return new InlineKeyboard();
  }

  private pickBtn(kb: InlineKeyboard, chatId: string, label: string, value: PickValue, flowId: string | null, ttlMs: number = TARGET_TTL_MS): InlineKeyboard {
    const ref = this.picks.issue(chatId, value, flowId, Date.now(), ttlMs);
    return kb.text(label, encodeCallback(this.key!, 'pick', ref, chatId));
  }

  private async lockdownOn(): Promise<boolean> {
    return (await this.lockdown.state()).enabled;
  }

  private async cmdNew(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const now = Date.now();
    if (!this.newRate.allow(chatId, now)) {
      await this.reply(ctx, RATE_LIMITED_TEXT);
      return;
    }
    if (await this.lockdownOn()) {
      await this.reply(ctx, LOCKDOWN_TEXT);
      return;
    }
    const startable = (await this.machines.list()).items.filter(isStartable);
    if (startable.length === 0) {
      await this.reply(ctx, NO_MACHINES_TEXT);
      return;
    }
    const flow = this.flows.start(chatId, now);
    let kb = this.newKb();
    for (const m of startable) {
      const name = m.displayName ?? m.hostname ?? m.slug;
      this.machineNames.set(m.id, name);
      kb = this.pickBtn(kb, chatId, `🖥 ${name}`, { kind: 'machine', machineId: m.id }, flow.id).row();
    }
    kb = this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
    const sent = await ctx.reply(formatMachinePicker(), { ...HTML, reply_markup: kb });
    flow.cardMessageId = sent.message_id;
  }

  private async cmdCancel(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const had = this.flows.get(chatId, Date.now()) !== null;
    this.flows.clear(chatId);
    await this.reply(ctx, had ? formatFlowCancelled() : 'Faol /new suhbati yo\'q.');
  }

  /** Papkalar: mashinaning ma'lum loyihalari (oxirgi ishlatilgani birinchi, <= 10). allowedRoots markazga yuborilmaydi: filtr yo'q, agentd siyosati baribir tekshiradi. */
  private async listFolders(machineId: string): Promise<FolderItem[]> {
    try {
      const { items } = await this.usage.projects({ machine: machineId, limit: 200 });
      const seen = new Set<string>();
      return items
        .filter((p) => p.machineId === machineId)
        .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name))
        .filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)))
        .slice(0, MAX_FOLDERS)
        .map((p) => ({ name: p.name, path: p.path }));
    } catch (err) {
      this.warn('project list failed (folders)', err);
      return [];
    }
  }

  private async editCard(chatId: string, messageId: number, text: string, kb: InlineKeyboard | null): Promise<void> {
    try {
      await this.bot!.api.editMessageText(chatId, messageId, text, { ...HTML, reply_markup: kb ?? { inline_keyboard: [] } });
    } catch (err) {
      if (!this.isNotModified(err)) this.warn('editMessageText (flow) failed', err);
    }
  }

  private async sendCard(chatId: string, text: string, kb: InlineKeyboard | null, replyTo?: number): Promise<number | null> {
    try {
      const m = await this.bot!.api.sendMessage(chatId, text, {
        ...HTML,
        ...(kb ? { reply_markup: kb } : {}),
        ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
      return m.message_id;
    } catch (err) {
      this.warn(`sendMessage failed (chat ${chatId})`, err);
      return null;
    }
  }

  private async sendForceReply(chatId: string, text: string, placeholder: string): Promise<number | null> {
    try {
      const m = await this.bot!.api.sendMessage(chatId, text, { ...HTML, reply_markup: { force_reply: true, input_field_placeholder: placeholder } });
      return m.message_id;
    } catch (err) {
      this.warn(`sendMessage (force_reply) failed (chat ${chatId})`, err);
      return null;
    }
  }

  private modelKb(chatId: string, flow: Flow): InlineKeyboard {
    let kb = this.newKb();
    for (const m of MODELS) kb = this.pickBtn(kb, chatId, m.label, { kind: 'model', model: m.alias }, flow.id);
    return this.pickBtn(kb.row(), chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
  }

  private modeKb(chatId: string, flow: Flow): InlineKeyboard {
    let kb = this.newKb();
    for (const mode of availableModes(flow.allowAuto)) kb = this.pickBtn(kb, chatId, MODE_LABELS[mode], { kind: 'mode', mode }, flow.id).row();
    return this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
  }

  private summaryKb(chatId: string, flow: Flow): InlineKeyboard {
    if (flowRequiresDashboard(flow)) return this.pickBtn(this.newKb(), chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
    let kb = this.pickBtn(this.newKb(), chatId, '✅ Ochish (hozir)', { kind: 'go' }, flow.id);
    if (this.queue) {
      kb = this.pickBtn(kb.row(), chatId, '🕒 Limit yangilanganda', { kind: 'queue_reset' }, flow.id).row();
      kb = this.pickBtn(kb, chatId, '🌙 Tunda (02:00)', { kind: 'queue_night' }, flow.id);
    }
    return this.pickBtn(kb.row(), chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
  }

  private autoKb(chatId: string, flow: Flow): InlineKeyboard {
    let kb = this.pickBtn(this.newKb(), chatId, '⚠️ Ha, Avto rejimda och', { kind: 'go_auto' }, flow.id).row();
    kb = this.pickBtn(kb, chatId, '↩️ Orqaga', { kind: 'back' }, flow.id);
    return this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
  }

  private static readonly STAGE_FOR: Record<PickValue['kind'], FlowStage[] | null> = {
    machine: ['machine'],
    folder: ['folder'],
    other_folder: ['folder'],
    model: ['model'],
    mode: ['mode'],
    go: ['summary'],
    go_auto: ['auto_confirm'],
    back: ['auto_confirm'],
    cancel: null, // istalgan bosqichda
    stop_ask: null,
    stop_yes: null,
    stop_no: null,
    queue_reset: ['summary'],
    queue_night: ['summary'],
    queue_cancel: null,
    git_diff: null,
    git_pr: null,
    git_pr_yes: null,
    git_pr_no: null,
    inv_ask: null,
    inv_go: null,
    inv_no: null,
    deploy_rb_ask: null,
    deploy_rb_yes: null,
    deploy_rb_no: null,
    tpl_list: ['task'],
    tpl_pick: ['task'],
    tpl_back: ['task'],
    rc_ask: null,
    rc_go: null,
    rc_no: null,
    resume_ask: null,
    resume_go: null,
    resume_no: null,
    close_ask: null,
    close_go: null,
    close_no: null,
  };

  private async handlePick(chatId: string, ref: string, messageId: number, answer: Answer): Promise<void> {
    const now = Date.now();
    const r = this.picks.resolve(chatId, ref, now);
    if (!r) {
      await answer('Tugma eskirgan. /new yoki /s', true);
      return;
    }
    const v = r.value;
    if (v.kind === 'queue_cancel') {
      await this.handleQueueCancel(chatId, messageId, v.id, answer);
      return;
    }
    if (v.kind === 'inv_ask' || v.kind === 'inv_go' || v.kind === 'inv_no') {
      await this.handleInvestigationPick(chatId, messageId, v, answer);
      return;
    }
    if (v.kind === 'stop_ask' || v.kind === 'stop_yes' || v.kind === 'stop_no') {
      await this.handleStopPick(chatId, messageId, v, answer);
      return;
    }
    if (v.kind === 'git_diff' || v.kind === 'git_pr' || v.kind === 'git_pr_yes' || v.kind === 'git_pr_no') {
      await this.handleGitPick(chatId, messageId, v, answer);
      return;
    }
    if (v.kind === 'resume_ask' || v.kind === 'resume_go' || v.kind === 'resume_no' || v.kind === 'close_ask' || v.kind === 'close_go' || v.kind === 'close_no') {
      await this.handleResumeClosePick(chatId, messageId, v, answer);
      return;
    }
    if (v.kind === 'rc_ask' || v.kind === 'rc_go' || v.kind === 'rc_no') {
      await this.handleRcPick(chatId, messageId, v, answer);
      return;
    }
    if (v.kind === 'deploy_rb_ask' || v.kind === 'deploy_rb_yes' || v.kind === 'deploy_rb_no') {
      await this.handleDeployPick(chatId, messageId, v, answer);
      return;
    }
    const flow = this.flows.get(chatId, now);
    if (!flow || flow.id !== r.flowId) {
      this.flows.consumeExpired(chatId);
      await answer('Suhbat muddati tugagan. /new bilan qayta boshlang', true);
      await this.editCard(chatId, messageId, FLOW_EXPIRED_TEXT, null);
      return;
    }
    if (await this.lockdownOn()) {
      this.flows.clear(chatId);
      await answer('Lockdown: buyruqlar bloklangan', true);
      await this.editCard(chatId, messageId, LOCKDOWN_TEXT, null);
      return;
    }
    const allowedStages = TelegramService.STAGE_FOR[v.kind];
    if (allowedStages && !allowedStages.includes(flow.stage)) {
      await answer(flow.stage === 'submitted' ? 'Allaqachon yuborilgan' : 'Bu tugma eskirgan', true);
      return;
    }
    flow.cardMessageId = messageId;

    switch (v.kind) {
      case 'cancel':
        this.flows.clear(chatId);
        await answer('❌ Bekor qilindi');
        await this.editCard(chatId, messageId, formatFlowCancelled(), null);
        return;
      case 'machine': {
        const m = await this.machines.findById(v.machineId);
        if (!m || !isStartable(m)) {
          await answer('Mashina endi mavjud emas yoki boshqaruv yoqilmagan', true);
          return;
        }
        flow.machineId = m.id;
        flow.machineName = m.displayName ?? m.hostname ?? m.slug;
        flow.allowAuto = m.control?.allowAutoMode === true;
        flow.stage = 'folder';
        const folders = await this.listFolders(m.id);
        let kb = this.newKb();
        for (const f of folders) kb = this.pickBtn(kb, chatId, `📁 ${f.name}`, { kind: 'folder', cwd: f.path }, flow.id).row();
        kb = this.pickBtn(kb, chatId, '✏️ Boshqa papka', { kind: 'other_folder' }, flow.id).row();
        kb = this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
        await answer();
        await this.editCard(chatId, messageId, formatFolderPicker(flow.machineName, folders), kb);
        return;
      }
      case 'folder':
        flow.cwd = v.cwd;
        flow.stage = 'model';
        await answer();
        await this.editCard(chatId, messageId, formatModelPicker(flow), this.modelKb(chatId, flow));
        return;
      case 'other_folder':
        flow.stage = 'path';
        await answer();
        await this.editCard(chatId, messageId, formatWaiting(flow, 'Papka: ✏️ yo\'l kutilmoqda…'), null);
        await this.sendForceReply(chatId, PATH_PROMPT_TEXT, '/Users/ism/loyiha');
        return;
      case 'model':
        flow.model = v.model;
        flow.stage = 'mode';
        await answer();
        await this.editCard(chatId, messageId, formatModePicker(flow), this.modeKb(chatId, flow));
        return;
      case 'mode':
        if (v.mode === 'auto' && !flow.allowAuto) {
          await answer('Bu mashinada Avto rejim yoqilmagan', true);
          return;
        }
        flow.mode = v.mode;
        flow.stage = 'task';
        await answer();
        await this.editCard(chatId, messageId, formatWaiting(flow, '✍️ Vazifa matni kutilmoqda…'), await this.taskWaitKb(chatId, flow));
        await this.sendForceReply(chatId, TASK_PROMPT_TEXT, 'Vazifa matni');
        return;
      case 'go':
        if (flowRequiresDashboard(flow)) {
          await answer("Bu vazifani faqat dashboard'da to'liq ko'rib oching", true);
          return;
        }
        if (flow.mode === 'auto') {
          flow.stage = 'auto_confirm';
          await answer('Avto rejimni tasdiqlang');
          await this.editCard(chatId, messageId, formatAutoConfirm(flow), this.autoKb(chatId, flow));
          return;
        }
        await this.submitStart(flow, chatId, messageId, answer);
        return;
      case 'go_auto':
        if (flowRequiresDashboard(flow)) {
          await answer("Bu vazifani faqat dashboard'da to'liq ko'rib oching", true);
          return;
        }
        if (flow.queue) await this.submitQueue(flow, chatId, messageId, answer);
        else await this.submitStart(flow, chatId, messageId, answer);
        return;
      case 'queue_reset':
      case 'queue_night':
        if (flowRequiresDashboard(flow)) {
          await answer("Bu vazifani faqat dashboard'da to'liq ko'rib oching", true);
          return;
        }
        flow.queue = v.kind === 'queue_reset' ? 'reset' : 'night';
        if (flow.mode === 'auto') {
          flow.stage = 'auto_confirm';
          await answer('Avto rejimni tasdiqlang');
          await this.editCard(chatId, messageId, formatAutoConfirm(flow), this.autoKb(chatId, flow));
          return;
        }
        await this.submitQueue(flow, chatId, messageId, answer);
        return;
      case 'tpl_list':
      case 'tpl_back':
        await this.showTemplateStep(flow, chatId, messageId, v.kind === 'tpl_list', answer);
        return;
      case 'tpl_pick':
        await this.pickTemplate(flow, chatId, messageId, v.templateId, answer);
        return;
      case 'back':
        flow.stage = 'summary';
        await answer();
        await this.editCard(chatId, messageId, formatSummary(flow), this.summaryKb(chatId, flow));
        return;
    }
  }

  /** Xulosa kartasidagi "Ochish" = chat ichidagi tasdiq: ikkinchi Telegram so'rovisiz yaratiladi. */
  /**
   * 3.1: yakuniy variant "Limit yangilanganda" / "Tunda (02:00)": xulosa kartasidagi tugma = chat ichidagi tasdiq (`telegram_inline`);
   * element `session.start` bilan bir xil step-up qoidasi bo'yicha yaratiladi va tasdiq elementda yoziladi.
   */
  private async submitQueue(flow: Flow, chatId: string, messageId: number, answer: Answer): Promise<void> {
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId || !this.queue) {
      await answer('Bu chat uchun ruxsat bekor qilingan yoki navbat o\'chiq', true);
      return;
    }
    if (flow.machineId === null || flow.cwd === null || flow.model === null || flow.mode === null || flow.text === null || flow.queue === null) {
      await answer('Suhbat to\'liq emas. /new bilan qayta boshlang', true);
      return;
    }
    const now = new Date();
    const night = flow.queue === 'night' ? nextCronRun('0 2 * * *', now) : null;
    const trigger = flow.queue === 'night' && night ? ({ type: 'at', at: night.toISOString() } as const) : ({ type: 'limit_reset', window: '5h' } as const);
    const prevStage = flow.stage;
    flow.stage = 'submitted';
    try {
      const item = await this.queue.create(
        { machineId: flow.machineId, cwd: flow.cwd, prompt: flow.text, model: flow.model, permissionMode: flow.mode, trigger },
        { deviceId, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' },
        now,
      );
      this.flows.clear(chatId); // vazifa matni xotiradan o'chadi
      await answer('🕒 Navbatga qo\'yildi');
      await this.editCard(chatId, messageId, formatQueued(item, now), null);
    } catch (err) {
      flow.stage = prevStage;
      if (!(err instanceof HttpException)) throw err;
      const resp = err.getResponse();
      const code = typeof resp === 'object' && resp !== null && typeof (resp as Record<string, unknown>)['error'] === 'string' ? ((resp as Record<string, unknown>)['error'] as string) : '';
      await answer(err.getStatus() === 403 ? 'Lockdown: buyruqlar bloklangan' : queueErrorTextUz(code), true);
    }
  }

  /** `/queue`: faol elementlar ro'yxati + har biri uchun bekor tugmasi (bekor qilish step-up talab qilmaydi, audit qilinadi). */
  private async cmdQueue(ctx: Context): Promise<void> {
    if (!this.queue) {
      await this.reply(ctx, 'Navbat o\'chiq.');
      return;
    }
    const chatId = String(ctx.chat!.id);
    const { items } = await this.queue.list({ limit: 10 });
    const active = items.filter((i) => i.status === 'queued' || i.status === 'waiting_trigger' || i.status === 'starting');
    let kb = this.newKb();
    active.forEach((it, i) => {
      if (it.status !== 'starting') kb = this.pickBtn(kb, chatId, `❌ ${i + 1}`, { kind: 'queue_cancel', id: it.id }, null, TARGET_TTL_MS);
    });
    await this.reply(ctx, formatQueueList(active, new Date()), active.length > 0 ? { reply_markup: kb } : {});
  }

  private async handleQueueCancel(chatId: string, messageId: number, id: string, answer: Answer): Promise<void> {
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId || !this.queue) {
      await answer('Ruxsat yo\'q', true);
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    try {
      const item = await this.queue.cancel(id, { deviceId, actorKind: 'telegram', ip: null });
      await answer(item.status === 'cancelled' ? '❌ Bekor qilindi' : 'Allaqachon ishga tushgan', item.status !== 'cancelled');
      const { items } = await this.queue.list({ limit: 10 });
      const active = items.filter((i) => i.status === 'queued' || i.status === 'waiting_trigger' || i.status === 'starting');
      let kb = this.newKb();
      active.forEach((it, i) => {
        if (it.status !== 'starting') kb = this.pickBtn(kb, chatId, `❌ ${i + 1}`, { kind: 'queue_cancel', id: it.id }, null, TARGET_TTL_MS);
      });
      await this.editCard(chatId, messageId, formatQueueList(active, new Date()), active.length > 0 ? kb : null);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 404) {
        await answer('Topilmadi', true);
        return;
      }
      throw err;
    }
  }

  private async submitStart(flow: Flow, chatId: string, messageId: number, answer: Answer): Promise<void> {
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    if (flow.machineId === null || flow.cwd === null || flow.model === null || flow.mode === null || flow.text === null) {
      await answer('Suhbat to\'liq emas. /new bilan qayta boshlang', true);
      return;
    }
    const prevStage = flow.stage;
    flow.stage = 'submitted'; // ikki marta bosishdan himoya (qo'shimcha: idempotentlik kaliti suhbatga bog'langan)
    const body: CreateCommandBody = { type: 'session.start', machineId: flow.machineId, cwd: flow.cwd, prompt: flow.text, model: flow.model, permissionMode: flow.mode };
    // 6.9: "katta vazifa" shabloni: avto-checkpoint (sozlama yoqilgan bo'lsa; best-effort)
    if (flow.bigTask) await beforeStartHooks.run({ kind: 'bigTask', machineId: flow.machineId, cwd: flow.cwd, label: 'telegram' }, { deviceId, actorKind: 'telegram', ip: null });
    const res = await this.submit(body, { deviceId, actorKind: 'telegram', ip: null, confirmation: 'telegram_inline' }, `tg-new-${flow.id}`);
    if (!res.ok) {
      flow.stage = prevStage;
      await answer(res.text, true);
      return;
    }
    const machineName = flow.machineName ?? flow.machineId;
    this.flows.clear(chatId); // vazifa matni xotiradan o'chadi
    await answer('✅ Yuborildi');
    this.trackProgress(res.dto.id, { chatId, messageId, kind: 'start', machineName });
    this.setReplyTarget(chatId, messageId, { sessionId: res.dto.sessionId, commandId: res.dto.id });
    await this.renderProgress(res.dto.id);
  }

  /** `commands.create` ni chaqiradi; HTTP xatolarini o'zbekcha matnga o'giradi. Biznes rad (rejected/failed qator) `ok` hisoblanadi: progress ko'rsatadi. */
  private async submit(body: CreateCommandBody, actor: CommandActor, key?: string): Promise<Submitted> {
    try {
      const r = await this.commands.create(body, actor, key);
      return { ok: true, dto: r.command };
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const status = err.getStatus();
      const resp = err.getResponse();
      const obj = typeof resp === 'object' && resp !== null ? (resp as Record<string, unknown>) : {};
      const code = typeof obj['error'] === 'string' ? obj['error'] : '';
      if (status === 403) return { ok: false, text: 'Lockdown: buyruqlar bloklangan' };
      if (status === 409) return { ok: false, text: commandErrorTextUz(code) };
      if (status === 429) return { ok: false, text: `Juda ko'p so'rov: ${typeof obj['retryAfterSeconds'] === 'number' ? `${obj['retryAfterSeconds']} s dan keyin ` : 'birozdan keyin '}urinib ko'ring` };
      if (status === 404) return { ok: false, text: 'Sessiya yoki mashina topilmadi' };
      if (status === 400) return { ok: false, text: 'So\'rov ma\'lumoti noto\'g\'ri' };
      this.warn(`command create failed (${status})`, err);
      return { ok: false, text: 'Xatolik, qayta urinib ko\'ring' };
    }
  }

  private trackProgress(commandId: string, entry: ProgressEntry): void {
    this.progress.set(commandId, entry);
    if (this.progress.size > MAX_PROGRESS) {
      const oldest = this.progress.keys().next().value;
      if (oldest !== undefined) this.progress.delete(oldest);
    }
  }

  private setReplyTarget(chatId: string, messageId: number, target: ReplyTarget): void {
    const k = `${chatId}:${messageId}`;
    this.replyTargets.delete(k);
    this.replyTargets.set(k, target);
    if (this.replyTargets.size > MAX_REPLY_TARGETS) {
      const oldest = this.replyTargets.keys().next().value;
      if (oldest !== undefined) this.replyTargets.delete(oldest);
    }
  }

  private stopKb(chatId: string, target: ReplyTarget): InlineKeyboard {
    return this.pickBtn(this.newKb(), chatId, '⏹ To\'xtatish', { kind: 'stop_ask', target }, null, TARGET_TTL_MS);
  }

  /** command.updated bo'yicha xabarni tahrirlaydi (Yuborildi -> Bajarilmoqda -> yakun). Yakuniy holatda kuzatuv to'xtaydi. */
  private async renderProgress(commandId: string): Promise<void> {
    const entry = this.progress.get(commandId);
    if (!entry || !this.bot) return;
    let dto: CommandDto;
    try {
      dto = await this.commands.getDto(commandId);
    } catch (err) {
      this.warn('progress getDto failed', err);
      return;
    }
    if (dto.status === 'awaiting_confirmation') return;
    const short = dto.claudeSessionId ?? dto.sessionId;
    const text = formatNewProgress(dto, { kind: entry.kind, machineName: entry.machineName, shortId: short ? short.slice(0, 8) : null, projectName: null });
    const done = dto.status === 'done';
    const kb = entry.kind === 'start' && done ? this.stopKb(entry.chatId, { sessionId: dto.sessionId, commandId: dto.id }) : null;
    await this.editCard(entry.chatId, entry.messageId, text, kb);
    this.setReplyTarget(entry.chatId, entry.messageId, { sessionId: dto.sessionId, commandId: dto.id });
    if (['done', 'failed', 'expired', 'rejected'].includes(dto.status)) this.progress.delete(commandId);
  }

  private async resolveSessionId(target: ReplyTarget): Promise<string | null> {
    if (target.sessionId) return target.sessionId;
    if (!target.commandId) return null;
    try {
      const dto = await this.commands.getDto(target.commandId);
      if (dto.sessionId) return dto.sessionId;
      if (dto.claudeSessionId) {
        const found = (await this.sessions.list(ListSessionsQuerySchema.parse({ limit: '200' }))).items.find((s) => s.claudeSessionId === dto.claudeSessionId);
        if (found) return found.id;
      }
    } catch (err) {
      this.warn('session resolve failed', err);
    }
    return null;
  }

  // --- stop ---------------------------------------------------------------------------------------

  private async handleStopPick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'stop_ask' | 'stop_yes' | 'stop_no' }>, answer: Answer): Promise<void> {
    const sessionId = await this.resolveSessionId(v.target);
    if (!sessionId) {
      await answer('Sessiya hali markaz bilan bog\'lanmagan: biroz kutib qayta bosing', true);
      return;
    }
    const target: ReplyTarget = { sessionId, commandId: v.target.commandId };
    if (v.kind === 'stop_no') {
      await answer();
      await this.editMarkup(chatId, messageId, this.stopKb(chatId, target));
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    if (v.kind === 'stop_ask') {
      let kb = this.pickBtn(this.newKb(), chatId, '⏹ Ha, to\'xtat', { kind: 'stop_yes', target }, null, TARGET_TTL_MS);
      kb = this.pickBtn(kb, chatId, '↩️ Orqaga', { kind: 'stop_no', target }, null, TARGET_TTL_MS);
      await answer('Tasdiqlang');
      await this.editMarkup(chatId, messageId, kb);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    await this.editMarkup(chatId, messageId, this.stopKb(chatId, target));
    const res = await this.submit({ type: 'session.stop', sessionId }, { deviceId, actorKind: 'telegram', ip: null });
    if (!res.ok) {
      await answer(res.text, true);
      return;
    }
    await answer('⏹ Yuborildi');
    const sent = await this.sendCard(chatId, '⏹ <b>To\'xtatish</b>\n⏳ Tayyorlanmoqda', null, messageId);
    if (sent === null) return;
    const machineName = res.dto.machineId ? await this.machineName(res.dto.machineId) : '';
    this.trackProgress(res.dto.id, { chatId, messageId: sent, kind: 'stop', machineName });
    await this.renderProgress(res.dto.id);
  }

  // --- 3.4: /new "Shablondan" bosqichi -----------------------------------------------------------

  /** Vazifa matni kutilayotgan karta tugmalari: shu loyiha uchun shablon bo'lsa "Shablondan" (aks holda tugma yo'q). */
  private async taskWaitKb(chatId: string, flow: Flow): Promise<InlineKeyboard | null> {
    const list = await this.templatesFor(flow);
    if (list.length === 0) return null;
    const kb = this.pickBtn(this.newKb(), chatId, `📋 Shablondan (${list.length})`, { kind: 'tpl_list' }, flow.id).row();
    return this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'cancel' }, flow.id);
  }

  private async templatesFor(flow: Flow): Promise<Awaited<ReturnType<TemplatesService['listForCwd']>>> {
    if (!this.templates || flow.machineId === null || flow.cwd === null) return [];
    try {
      return await this.templates.listForCwd(flow.machineId, flow.cwd);
    } catch (err) {
      this.warn('template list failed', err);
      return [];
    }
  }

  /** `tpl_list`: shablonlar ro'yxati; `tpl_back`: kutish kartasiga qaytish. */
  private async showTemplateStep(flow: Flow, chatId: string, messageId: number, list: boolean, answer: Answer): Promise<void> {
    if (!list) {
      await answer();
      await this.editCard(chatId, messageId, formatWaiting(flow, '✍️ Vazifa matni kutilmoqda…'), await this.taskWaitKb(chatId, flow));
      return;
    }
    const items = await this.templatesFor(flow);
    if (items.length === 0) {
      await answer('Bu loyiha uchun shablon yo\'q', true);
      return;
    }
    let kb = this.newKb();
    for (const t of items.slice(0, MAX_TEMPLATE_BUTTONS)) kb = this.pickBtn(kb, chatId, templateButtonLabel(t), { kind: 'tpl_pick', templateId: t.id }, flow.id).row();
    kb = this.pickBtn(kb, chatId, '↩️ Orqaga', { kind: 'tpl_back' }, flow.id);
    await answer();
    await this.editCard(chatId, messageId, formatTemplatePicker(items), kb);
  }

  /** Shablon markazda render qilinadi; yetishmayotgan o'zgaruvchi bo'lsa tanlov ochiq qoladi. Natija vazifa matniga aylanadi (xulosa kartasi). */
  private async pickTemplate(flow: Flow, chatId: string, messageId: number, templateId: string, answer: Answer): Promise<void> {
    if (!this.templates || flow.machineId === null || flow.cwd === null) {
      await answer('Shablonlar mavjud emas', true);
      return;
    }
    try {
      const r = await this.templates.render(templateId, { machineId: flow.machineId, cwd: flow.cwd });
      const meta = (await this.templatesFor(flow)).find((t) => t.id === templateId);
      if (r.missing.length > 0) {
        await answer('Qiymat yetishmaydi', true);
        await this.editCard(chatId, messageId, formatTemplateMissing(meta?.name ?? 'Shablon', r.missing), (await this.taskWaitKb(chatId, flow)) ?? null);
        return;
      }
      if (r.tooLong) {
        await answer('Matn juda uzun', true);
        await this.editCard(chatId, messageId, TEMPLATE_TOO_LONG_TEXT, (await this.taskWaitKb(chatId, flow)) ?? null);
        return;
      }
      flow.text = r.text;
      flow.bigTask = meta?.bigTask === true;
      flow.stage = 'summary';
      await answer(`📋 ${meta?.name ?? 'Shablon'}`);
      await this.editCard(chatId, messageId, formatSummary(flow), this.summaryKb(chatId, flow));
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 404) {
        await answer('Shablon topilmadi', true);
        return;
      }
      this.warn('template render failed', err);
      await answer('Xatolik, qayta urinib ko\'ring', true);
    }
  }

  // --- 3.10: Remote Control (/s kartasi) -----------------------------------------------------------

  private rcBtn(kb: InlineKeyboard, chatId: string, s: SessionDto): InlineKeyboard {
    const target: ReplyTarget = { sessionId: s.id, commandId: null };
    const on = s.remoteControl?.enabled === true;
    const value: PickValue = on ? { kind: 'rc_go', target, enable: false } : { kind: 'rc_ask', target };
    if ((kb.inline_keyboard.at(-1)?.length ?? 0) > 0) kb.row();
    return this.pickBtn(kb, chatId, on ? '🛰 Remote Control: o\'chirish' : '🛰 Remote Control: yoqish', value, null, TARGET_TTL_MS);
  }

  /** Yoqish = chat ichidagi aniq tasdiq (`telegram_inline`: ikkinchi so'rovsiz step-up o'rnini bosadi); o'chirish tasdiqsiz. */
  /**
   * 6.4: hodisadan tekshiruv. `inv_ask` = tasdiqlash kartasi (mashina, papka, model, plan rejimi); `inv_go` = chat ichidagi aniq tasdiq
   * (`telegram_inline`: mavjud step-up qoidasi bo'yicha ikkinchi so'rov yuborilmaydi) va `session.start`; `inv_no` = bekor.
   * Allowlist har callbackda qayta tekshirilgan; lockdown va qurilma ruxsati bu yerda.
   */
  private async handleInvestigationPick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'inv_ask' | 'inv_go' | 'inv_no' }>, answer: Answer): Promise<void> {
    if (v.kind === 'inv_no') {
      await answer('❌ Bekor qilindi');
      await this.editCard(chatId, messageId, '🔍 <b>Claude tekshirsin</b>\n❌ Bekor qilindi', null);
      return;
    }
    const port = telegramInvestigations.get();
    if (!port) {
      await answer('Tekshiruv funksiyasi o\'chiq', true);
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    if (v.kind === 'inv_ask') {
      const card = await port.preview(v.subject, v.id);
      if (!card.ok) {
        await answer();
        await this.sendCard(chatId, card.text, null, messageId);
        return;
      }
      let kb = this.pickBtn(this.newKb(), chatId, '✅ Boshlash (plan)', { kind: 'inv_go', subject: v.subject, id: v.id }, null, TARGET_TTL_MS);
      kb = this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'inv_no' }, null, TARGET_TTL_MS);
      await answer();
      await this.sendCard(chatId, card.text, kb, messageId);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    await answer('⏳ Yuborilmoqda');
    await this.editMarkup(chatId, messageId, new InlineKeyboard()); // ikki marta bosish ikki sessiya ochmasin
    const res = await port.start(v.subject, v.id, deviceId);
    await this.editCard(chatId, messageId, res.text, null);
  }

  private async handleRcPick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'rc_ask' | 'rc_go' | 'rc_no' }>, answer: Answer): Promise<void> {
    const sessionId = await this.resolveSessionId(v.target);
    if (!sessionId) {
      await answer('Sessiya markaz bilan bog\'lanmagan: biroz kutib qayta bosing', true);
      return;
    }
    const target: ReplyTarget = { sessionId, commandId: v.target.commandId };
    if (v.kind === 'rc_no') {
      await answer();
      const card = await this.sessions.get(sessionId).catch(() => null);
      const kb = card ? this.sessionCardKb(chatId, card) : undefined;
      if (kb) await this.editMarkup(chatId, messageId, kb);
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    if (v.kind === 'rc_ask') {
      let kb = this.pickBtn(this.newKb(), chatId, '✅ Ha, claude.ai dan boshqarishga och', { kind: 'rc_go', target, enable: true }, null, TARGET_TTL_MS);
      kb = this.pickBtn(kb.row(), chatId, '↩️ Orqaga', { kind: 'rc_no', target }, null, TARGET_TTL_MS);
      await answer(RC_CONFIRM_TOAST, true);
      await this.editMarkup(chatId, messageId, kb);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    const res = await this.submit({ type: 'session.remote_control', sessionId, enable: v.enable }, { deviceId, actorKind: 'telegram', ip: null, ...(v.enable ? { confirmation: 'telegram_inline' as const } : {}) });
    if (!res.ok) {
      await answer(res.text, true);
      return;
    }
    await answer('🛰 Yuborildi');
    const sent = await this.sendCard(chatId, formatRcResult(res.dto, v.enable), null, messageId);
    if (sent === null) return;
    void this.followRc(chatId, sent, res.dto.id, v.enable).catch((err: unknown) => this.warn('rc follow failed', err));
  }

  /** Buyruq yakuniga yetguncha kutadi (alohida vazifa: polling'ni bloklamaydi) va kartani yangilaydi. */
  private async followRc(chatId: string, messageId: number, commandId: string, enable: boolean): Promise<void> {
    const { command } = await this.commands.waitFinished(commandId, 60_000);
    await this.editCard(chatId, messageId, formatRcResult(command, enable), null);
  }

  /**
   * 6.14: "▶️ Davom ettirish" (tugagan terminal sessiya -> tmux'da `claude --resume`) va "⏹ Yopish" (tmux sessiyani yopish).
   * `*_ask` = tasdiq kartasi; `*_go` = chat ichidagi aniq tasdiq (`telegram_inline`: ikkinchi so'rovsiz; close step-up talab qilmaydi) va buyruq;
   * `*_no` = orqaga. Allowlist har callbackda qayta tekshirilgan; lockdown shu yerda; siyosat/agentd qarori markazda.
   */
  private async handleResumeClosePick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'resume_ask' | 'resume_go' | 'resume_no' | 'close_ask' | 'close_go' | 'close_no' }>, answer: Answer): Promise<void> {
    const sessionId = await this.resolveSessionId(v.target);
    if (!sessionId) {
      await answer('Sessiya markaz bilan bog\'lanmagan: biroz kutib qayta bosing', true);
      return;
    }
    const target: ReplyTarget = { sessionId, commandId: v.target.commandId };
    const resume = v.kind.startsWith('resume');
    if (v.kind === 'resume_no' || v.kind === 'close_no') {
      await answer();
      const card = await this.sessions.get(sessionId).catch(() => null);
      const kb = card ? this.sessionCardKb(chatId, card) : undefined;
      await this.editMarkup(chatId, messageId, kb ?? new InlineKeyboard());
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    if (v.kind === 'resume_ask' || v.kind === 'close_ask') {
      const label = resume ? '✅ Ha, davom ettir (tmux)' : '⏹ Ha, yop';
      let kb = this.pickBtn(this.newKb(), chatId, label, { kind: resume ? 'resume_go' : 'close_go', target }, null, TARGET_TTL_MS);
      kb = this.pickBtn(kb.row(), chatId, '↩️ Orqaga', { kind: resume ? 'resume_no' : 'close_no', target }, null, TARGET_TTL_MS);
      await answer(resume ? 'Sessiya shu mashinada tmux ichida davom ettiriladi. Tasdiqlaysizmi?' : 'Claude /exit bilan yopiladi (Commander ochgan tmux sessiya o\'chiriladi). Tasdiqlaysizmi?', true);
      await this.editMarkup(chatId, messageId, kb);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    await this.editMarkup(chatId, messageId, new InlineKeyboard()); // ikki marta bosish ikki buyruq bo'lmasin
    const res = await this.submit(resume ? { type: 'session.resume', sessionId } : { type: 'session.close', sessionId }, { deviceId, actorKind: 'telegram', ip: null, ...(resume ? { confirmation: 'telegram_inline' as const } : {}) });
    if (!res.ok) {
      await answer(res.text, true);
      return;
    }
    await answer('Yuborildi');
    const head = resume ? '▶️ <b>Davom ettirish</b>' : '⏹ <b>Yopish</b>';
    const sent = await this.sendCard(chatId, `${head}\n⏳ Bajarilmoqda…`, null, messageId);
    if (sent === null) return;
    void this.followResumeClose(chatId, sent, res.dto.id, resume).catch((err: unknown) => this.warn('resume/close follow failed', err));
  }

  private async followResumeClose(chatId: string, messageId: number, commandId: string, resume: boolean): Promise<void> {
    const { command } = await this.commands.waitFinished(commandId, 90_000);
    await this.editCard(chatId, messageId, formatResumeCloseResult(command, resume), null);
  }

  /** /s kartasi tugmalari: To'xtatish (siyosat ruxsat bersa) + Remote Control (tmux sessiya, agentd e'lon qilgan, allowPrompt). */
  private sessionCardKb(chatId: string, s: SessionDto): InlineKeyboard | undefined {
    let kb = s.controls.stop ? this.stopKb(chatId, { sessionId: s.id, commandId: null }) : undefined;
    if (s.controls.remoteControl) kb = this.rcBtn(kb ?? this.newKb(), chatId, s);
    const target: ReplyTarget = { sessionId: s.id, commandId: null };
    // 6.14: tmux sessiyani yopish; tugagan terminal sessiyani davom ettirish
    if (s.controls.close === true && s.endedAt === null) kb = this.pickBtn((kb ?? this.newKb()).row(), chatId, '⏹ Yopish', { kind: 'close_ask', target }, null, TARGET_TTL_MS);
    if (s.resume?.available === true) kb = this.pickBtn((kb ?? this.newKb()).row(), chatId, '▶️ Davom ettirish', { kind: 'resume_ask', target }, null, TARGET_TTL_MS);
    return kb;
  }

  // --- Git/PR (3.5): sessiya tugagach Diff va PR ochish -------------------------------------------

  /** Commander ochgan (`started_by = remote`) va loyihaga bog'langan sessiya tugaganda: "📄 Diff" va "🔀 PR ochish" tugmalari. */
  private async gitDoneKeyboard(sessionId: string, projectId: string | null): Promise<((chatId: string) => InlineKeyboard) | null> {
    if (!this.git || !projectId) return null;
    try {
      const ctx = await this.git.prContextForSession(sessionId);
      if (ctx?.startedBy !== 'remote') return null;
    } catch (err) {
      this.warn('git context failed', err);
      return null;
    }
    return (chatId) => {
      let kb = this.pickBtn(this.newKb(), chatId, '📄 Diff', { kind: 'git_diff', sessionId }, null, TARGET_TTL_MS);
      kb = this.pickBtn(kb, chatId, '🔀 PR ochish', { kind: 'git_pr', sessionId }, null, TARGET_TTL_MS);
      return kb;
    };
  }

  private async handleGitPick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'git_diff' | 'git_pr' | 'git_pr_yes' | 'git_pr_no' }>, answer: Answer): Promise<void> {
    if (v.kind === 'git_pr_no') {
      await answer('❌ Bekor qilindi');
      await this.editCard(chatId, messageId, '🔀 <b>PR ochish</b>\n❌ Bekor qilindi', null);
      return;
    }
    if (!this.git) {
      await answer('Git funksiyasi o\'chiq', true);
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    const actor: CommandActor = { deviceId, actorKind: 'telegram', ip: null };
    try {
      if (v.kind === 'git_diff') {
        await answer('⏳ Diff olinmoqda');
        const r = await this.git.diffForSession(v.sessionId, { statOnly: true }, actor);
        const ctx = await this.git.prContextForSession(v.sessionId);
        await this.sendCard(chatId, formatDiffStat(r.diff, { projectName: ctx?.projectName ?? r.projectId, baseSource: r.baseSource }), null, messageId);
        return;
      }
      const ctx = await this.git.prContextForSession(v.sessionId);
      if (!ctx) {
        await answer('Sessiya loyihaga bog\'lanmagan', true);
        return;
      }
      const def = buildPrDefaults({ branch: ctx.branch, taskKey: ctx.taskKey, taskTitle: ctx.taskTitle, sessionName: ctx.sessionName, commitSubjects: ctx.commitSubjects });
      if (v.kind === 'git_pr') {
        let kb = this.pickBtn(this.newKb(), chatId, '✅ PR ochish', { kind: 'git_pr_yes', sessionId: v.sessionId }, null, TARGET_TTL_MS);
        kb = this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'git_pr_no' }, null, TARGET_TTL_MS);
        await answer();
        await this.sendCard(chatId, formatPrCard({ projectName: ctx.projectName, title: def.title, head: ctx.branch, base: GIT_PR_DEFAULT_BASE }), kb, messageId);
        return;
      }
      // git_pr_yes: chat ichidagi aniq tasdiq = step-up (audit: confirmation=telegram_inline)
      await this.editMarkup(chatId, messageId, new InlineKeyboard());
      const res = await this.git.openPr(
        ctx.projectId,
        { title: def.title, body: def.body, base: GIT_PR_DEFAULT_BASE, draft: false, ...(ctx.branch ? { head: ctx.branch } : {}) },
        { ...actor, confirmation: 'telegram_inline' },
        `tg-pr-${v.sessionId.slice(0, 8)}-${Math.floor(Date.now() / 60_000)}`,
      );
      await answer('✅ Yuborildi');
      this.gitProgress.set(res.command.id, { chatId, messageId });
      if (this.gitProgress.size > MAX_PROGRESS) {
        const oldest = this.gitProgress.keys().next().value;
        if (oldest !== undefined) this.gitProgress.delete(oldest);
      }
      await this.renderGitProgress(res.command.id);
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const resp = err.getResponse();
      const code = typeof resp === 'object' && resp !== null && typeof (resp as Record<string, unknown>)['error'] === 'string' ? ((resp as Record<string, unknown>)['error'] as string) : '';
      await answer(err.getStatus() === 429 ? 'Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring' : gitErrorTextUz(code), true);
    }
  }

  private async renderGitProgress(commandId: string): Promise<void> {
    const entry = this.gitProgress.get(commandId);
    if (!entry || !this.bot) return;
    let dto: CommandDto;
    try {
      dto = await this.commands.getDto(commandId);
    } catch (err) {
      this.warn('git progress getDto failed', err);
      return;
    }
    await this.editCard(entry.chatId, entry.messageId, formatPrProgress(dto), null);
    if (['done', 'failed', 'expired', 'rejected'].includes(dto.status)) this.gitProgress.delete(commandId);
  }

  // --- 6.5: deploy bildirishnomalari va rollback ---------------------------------------------------

  /** Deploy boshlandi / tugadi (Rollback tugmasi bilan). Faqat nomlar/holatlar/qisqartmalar: chiqish matni Telegram'ga yuborilmaydi. */
  private async onDeployNotice(n: DeployNotice): Promise<void> {
    if (!this.bot || !this.deployApi) return;
    const dedupe = `${n.kind}:${n.commandId}`;
    if (this.deployNoticed.has(dedupe)) return;
    const ctx = await this.deployApi.rollbackContext(n.commandId);
    if (!ctx) return;
    this.deployNoticed.add(dedupe);
    if (this.deployNoticed.size > 400) {
      const oldest = this.deployNoticed.values().next().value;
      if (oldest !== undefined) this.deployNoticed.delete(oldest);
    }
    const dto = await this.commands.getDto(n.commandId);
    const card = { projectName: ctx.projectName, machineName: await this.machineName(dto.machineId) };
    if (n.kind === 'started') {
      await this.send(formatDeployStarted(ctx.run, card));
      return;
    }
    // Rollback tugmasi: retseptda rollback qadamlari bor, bu deploy (rollback emas) va avtomatik rollback allaqachon bajarilmagan
    const s = ctx.run.summary;
    const offer = ctx.run.kind === 'run' && s !== null && s.rollbackDefined && s.outcome !== 'rolled_back';
    await this.send(formatDeployFinished(ctx.run, card), offer ? (chatId) => this.pickBtn(this.newKb(), chatId, '↩️ Rollback', { kind: 'deploy_rb_ask', commandId: n.commandId }, null, DEPLOY_BUTTON_TTL_MS) : undefined);
  }

  private async handleDeployPick(chatId: string, messageId: number, v: Extract<PickValue, { kind: 'deploy_rb_ask' | 'deploy_rb_yes' | 'deploy_rb_no' }>, answer: Answer): Promise<void> {
    if (v.kind === 'deploy_rb_no') {
      await answer('❌ Bekor qilindi');
      await this.editCard(chatId, messageId, '↩️ <b>Rollback</b>\n❌ Bekor qilindi', null);
      return;
    }
    if (!this.deployApi) {
      await answer('Deploy funksiyasi o\'chiq', true);
      return;
    }
    if (await this.lockdownOn()) {
      await answer('Lockdown: buyruqlar bloklangan', true);
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) {
      await answer('Bu chat uchun ruxsat bekor qilingan', true);
      return;
    }
    const ctx = await this.deployApi.rollbackContext(v.commandId);
    if (!ctx || !ctx.run.summary?.rollbackDefined) {
      await answer('Rollback qadamlari yo\'q yoki deploy topilmadi', true);
      return;
    }
    const actor: CommandActor = { deviceId, actorKind: 'telegram', ip: null };
    try {
      if (v.kind === 'deploy_rb_ask') {
        const dto = await this.commands.getDto(v.commandId);
        const kb = this.pickBtn(this.newKb(), chatId, '✅ Ha, rollback', { kind: 'deploy_rb_yes', commandId: v.commandId }, null, TARGET_TTL_MS);
        const kb2 = this.pickBtn(kb, chatId, '❌ Bekor', { kind: 'deploy_rb_no' }, null, TARGET_TTL_MS);
        await answer();
        await this.sendCard(chatId, formatRollbackCard(ctx.run, { projectName: ctx.projectName, machineName: await this.machineName(dto.machineId) }), kb2, messageId);
        return;
      }
      // deploy_rb_yes: chat ichidagi aniq tasdiq (target + commit + xesh kartada ko'rsatilgan) = step-up (audit: confirmation=telegram_inline)
      await this.editMarkup(chatId, messageId, new InlineKeyboard());
      const res = await this.deployApi.rollback(
        ctx.projectId,
        { target: ctx.run.target, recipeHash: ctx.run.recipeHash, commit: ctx.run.commit },
        { ...actor, confirmation: 'telegram_inline' },
        `tg-rb-${v.commandId.slice(0, 8)}-${Math.floor(Date.now() / 60_000)}`,
      );
      await answer('✅ Yuborildi');
      const failed = ['rejected', 'failed', 'expired'].includes(res.command.status);
      await this.editCard(chatId, messageId, failed ? `↩️ <b>Rollback</b>\n⚠️ ${escapeHtml(deployErrorTextUz(res.command.errorCode))}` : '↩️ <b>Rollback</b>\n⏳ Yuborildi: natija alohida xabarda', null);
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const resp = err.getResponse();
      const code = typeof resp === 'object' && resp !== null && typeof (resp as Record<string, unknown>)['error'] === 'string' ? ((resp as Record<string, unknown>)['error'] as string) : '';
      await answer(err.getStatus() === 429 ? 'Juda ko\'p so\'rov: birozdan keyin urinib ko\'ring' : deployErrorTextUz(code), true);
    }
  }

  /** CI muvaffaqiyatsiz (Commander ochgan PR): bir run uchun bir marta (markaz `failed_notified_run_id` bilan kafolatlaydi). */
  private async onCiFailed(n: CiFailureNotice): Promise<void> {
    if (!this.bot || !this.git) return;
    await this.send(formatCiFailure(n, await this.git.projectName(n.projectId)));
  }

  // --- matnli xabarlar: papka yo'li, vazifa matni, sessiyaga reply-prompt ---------------------------

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    // Ro'yxatdan o'tgan buyruqlar (/new, /s, ...) yuqorida ushlanadi; '/Users/ism' kabi yo'l bu yerga tushadi.
    if (text === undefined) return;
    const chatId = String(ctx.chat!.id);
    const now = Date.now();

    const replied = ctx.message?.reply_to_message?.message_id;
    const otherTarget = replied !== undefined ? this.otherTargets.get(`${chatId}:${replied}`) : undefined;
    if (otherTarget) {
      await this.handleQuestionOther(ctx, chatId, otherTarget, text);
      return;
    }
    const planApproval = replied !== undefined ? this.planTargets.get(`${chatId}:${replied}`) : undefined;
    if (planApproval) {
      await this.handlePlanFeedback(ctx, chatId, planApproval, text);
      return;
    }
    const target = replied !== undefined ? this.replyTargets.get(`${chatId}:${replied}`) : undefined;
    if (target) {
      await this.sendPrompt(ctx, chatId, target, text);
      return;
    }

    const flow = this.flows.get(chatId, now);
    if (!flow) {
      if (this.flows.consumeExpired(chatId)) await this.reply(ctx, FLOW_EXPIRED_TEXT);
      else if (!text.startsWith('/')) await this.askPlainText(ctx, chatId, text);
      return;
    }
    if (flow.stage === 'path') {
      const p = parseTypedPath(text);
      if (!p.ok) {
        await this.reply(ctx, formatPathError(p.reason));
        return;
      }
      flow.cwd = p.path;
      flow.stage = 'model';
      const id = await this.sendCard(chatId, formatModelPicker(flow), this.modelKb(chatId, flow));
      if (id !== null) flow.cardMessageId = id;
      return;
    }
    if (flow.stage === 'task') {
      const t = validTaskText(text);
      if (!t.ok) {
        await this.reply(ctx, formatTaskError(t.reason));
        return;
      }
      flow.text = t.text;
      flow.stage = 'summary';
      const id = await this.sendCard(chatId, formatSummary(flow), this.summaryKb(chatId, flow));
      if (id !== null) flow.cardMessageId = id;
    }
  }

  /** Boshqa suhbat/reply bo'lmaganda oddiy matn = Commander'dan savol (6.2; `ask` kengaytmasi). Kengaytma yo'q bo'lsa jim. */
  private async askPlainText(ctx: Context, chatId: string, text: string): Promise<void> {
    const handler = telegramExtensions.get('ask');
    if (!handler) return;
    try {
      for (const part of await handler(text, chatId)) await this.reply(ctx, part);
    } catch (err) {
      this.warn('plain-text ask failed', err);
      await this.reply(ctx, "Savolga javob olib bo'lmadi. Keyinroq urinib ko'ring.");
    }
  }

  /** Sessiya xabariga reply: `session.prompt` (step-up yo'q, audit bor). */
  private async sendPrompt(ctx: Context, chatId: string, target: ReplyTarget, raw: string): Promise<void> {
    if (await this.lockdownOn()) {
      await this.reply(ctx, LOCKDOWN_TEXT);
      return;
    }
    const t = validTaskText(raw);
    if (!t.ok) {
      await this.reply(ctx, formatTaskError(t.reason));
      return;
    }
    const deviceId = await this.access.deviceFor(chatId);
    if (!deviceId) return;
    const sessionId = await this.resolveSessionId(target);
    if (!sessionId) {
      await this.reply(ctx, 'Sessiya hali markaz bilan bog\'lanmagan: biroz kutib qayta yozing.');
      return;
    }
    const res = await this.submit({ type: 'session.prompt', sessionId, text: t.text }, { deviceId, actorKind: 'telegram', ip: null });
    if (!res.ok) {
      await this.reply(ctx, `⚠️ Yuborilmadi: ${escapeHtml(res.text)}`);
      return;
    }
    const sent = await this.sendCard(chatId, '✉️ <b>Prompt</b>\n⏳ Tayyorlanmoqda', null, ctx.message!.message_id);
    if (sent === null) return;
    const machineName = await this.machineName(res.dto.machineId);
    this.trackProgress(res.dto.id, { chatId, messageId: sent, kind: 'prompt', machineName });
    this.setReplyTarget(chatId, sent, { sessionId, commandId: null });
    await this.renderProgress(res.dto.id);
  }

  // --- /s ------------------------------------------------------------------------------------------

  private async cmdSession(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const arg = (typeof ctx.match === 'string' ? ctx.match : '').trim();
    if (arg === '') {
      const { items } = await this.sessions.list(ListSessionsQuerySchema.parse({ active: '1', limit: '10' }));
      await this.reply(ctx, formatSessionList(items));
      return;
    }
    const parsed = parseSessionArg(arg);
    let found: SessionDto | null = null;
    if (parsed.kind === 'invalid') {
      await this.reply(ctx, 'Foydalanish: <code>/s</code> (ro\'yxat), <code>/s &lt;raqam&gt;</code> yoki <code>/s &lt;id&gt;</code>');
      return;
    }
    if (parsed.kind === 'index') {
      const { items } = await this.sessions.list(ListSessionsQuerySchema.parse({ active: '1', limit: '10' }));
      found = items[parsed.n - 1] ?? null;
    } else {
      const { items } = await this.sessions.list(ListSessionsQuerySchema.parse({ limit: '200' }));
      const hits = items.filter((s) => s.id.startsWith(parsed.prefix) || s.claudeSessionId.toLowerCase().startsWith(parsed.prefix));
      if (hits.length > 1) {
        await this.reply(ctx, 'Bir nechta sessiya mos keldi: id\'ni uzunroq yozing.');
        return;
      }
      found = hits[0] ?? null;
    }
    if (!found) {
      await this.reply(ctx, 'Sessiya topilmadi. /s — faol sessiyalar ro\'yxati.');
      return;
    }
    const kb = this.sessionCardKb(chatId, found);
    const sent = await ctx.reply(formatSessionCard(found), { ...HTML, ...(kb ? { reply_markup: kb } : {}) });
    this.setReplyTarget(chatId, sent.message_id, { sessionId: found.id, commandId: null });
  }

  // --- tugmalar va xabarlarni tahrirlash -------------------------------------------------------

  private fmt(dto: ApprovalDto, lockdown: boolean): string {
    return formatApproval(dto, { lockdown, ...(dto.kind === 'question' ? { questionIndex: this.questionFlows.get(dto.id)?.current ?? 0 } : {}) });
  }

  /** Savol klaviaturasi: variantlar (har biriga bitta tugma), Boshqa…, multiSelect Yuborish, Rad. Lockdown'da faqat Rad. */
  private questionKeyboard(dto: Pick<ApprovalDto, 'id' | 'questions'>, chatId: string | number, lockdown: boolean): InlineKeyboard {
    const key = this.key!;
    const kb = new InlineKeyboard();
    if (lockdown || !dto.questions) return kb.text('❌ Rad', encodeCallback(key, 'deny', dto.id, chatId));
    const flow = this.questionFlows.get(dto.id) ?? newFlow(dto.questions.length);
    const rows = questionButtons(dto.questions, flow);
    rows.forEach((row, i) => {
      for (const btn of row) kb.text(btn.text, encodeCallback(key, btn.action === 'deny' ? 'deny' : btn.action, dto.id, chatId, btn.arg ?? ''));
      if (i < rows.length - 1) kb.row();
    });
    return kb;
  }

  private mainKeyboard(dto: Pick<ApprovalDto, 'id' | 'kind' | 'toolName' | 'sessionId' | 'toolInputRedacted' | 'questions'>, chatId: string | number, lockdown: boolean): InlineKeyboard {
    const key = this.key!;
    const approvalId = dto.id;
    if (dto.kind === 'question') return this.questionKeyboard(dto, chatId, lockdown);
    const kb = new InlineKeyboard();
    if (dto.kind === 'plan') {
      // Reja: masofaviy allow Claude Code'da ishlamaydi (PLAN_REMOTE_APPROVE_SUPPORTED=false): faqat fikr bilan rad / rad.
      if (PLAN_REMOTE_APPROVE_SUPPORTED && !lockdown) kb.text('✅ Rejani tasdiqlash', encodeCallback(key, 'ask', approvalId, chatId));
      kb.text('✏️ Fikr bilan rad', encodeCallback(key, 'fb', approvalId, chatId));
      return kb.text('❌ Rad', encodeCallback(key, 'deny', approvalId, chatId));
    }
    // H-04: ko'p qismi yashirilgan yoki kesilgan qismda xavfli andoza bor so'rovga Telegram'da bir-tap ruxsat YO'Q (faqat dashboard).
    const dashboardOnly = approvalRequiresDashboard(dto);
    if (!lockdown && !dashboardOnly) kb.text('✅ Ruxsat', encodeCallback(key, 'ask', approvalId, chatId));
    kb.text('❌ Rad', encodeCallback(key, 'deny', approvalId, chatId));
    if (!lockdown && !dashboardOnly && this.ruleButtonApplies(dto)) kb.row().text('⚡ Shu sessiyada Edit/Write ga 1 soat avto-ruxsat', encodeCallback(key, 'rule', approvalId, chatId));
    return kb;
  }

  private confirmKeyboard(approvalId: string, chatId: string | number): InlineKeyboard {
    const key = this.key!;
    return new InlineKeyboard().text('✅ Ha, ruxsat ber', encodeCallback(key, 'confirm', approvalId, chatId)).text('↩️ Orqaga', encodeCallback(key, 'back', approvalId, chatId));
  }

  private isNotModified(err: unknown): boolean {
    return err instanceof GrammyError && /not modified/i.test(err.description);
  }

  private async editMarkup(chatId: string, messageId: number, kb: InlineKeyboard): Promise<void> {
    try {
      await this.bot!.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: kb });
    } catch (err) {
      if (!this.isNotModified(err)) this.warn('editMessageReplyMarkup failed', err);
    }
  }

  /** Yakuniy holat: matn yangilanadi, tugmalar olib tashlanadi (pending bo'lsa tugmalar qoladi). */
  private async editApproval(chatId: string, messageId: number, dto: ApprovalDto, lockdown: boolean): Promise<void> {
    if (messageId <= 0) return;
    try {
      await this.bot!.api.editMessageText(chatId, messageId, this.fmt(dto, lockdown), {
        ...HTML,
        reply_markup: dto.status === 'pending' ? this.mainKeyboard(dto, chatId, lockdown) : { inline_keyboard: [] },
      });
    } catch (err) {
      if (!this.isNotModified(err)) this.warn('editMessageText failed', err);
    }
  }

  private trackMessage(approvalId: string, chatId: string, messageId: number, kind: 'tool' | 'plan' | 'question' = 'tool'): void {
    if (kind === 'plan') this.setPlanTarget(chatId, messageId, approvalId);
    const per = this.approvalMessages.get(approvalId) ?? new Map<string, number>();
    per.set(chatId, messageId);
    this.approvalMessages.delete(approvalId);
    this.approvalMessages.set(approvalId, per);
    if (this.approvalMessages.size > MAX_TRACKED_APPROVALS) {
      const oldest = this.approvalMessages.keys().next().value;
      if (oldest !== undefined) this.approvalMessages.delete(oldest);
    }
  }

  // --- yuborish --------------------------------------------------------------------------------

  /** Allowlist'dagi barcha chatlarga; xato bitta chatga ta'sir qiladi, qolganlariga emas. */
  private async send(text: string, markup?: (chatId: string) => InlineKeyboard): Promise<Array<{ chatId: string; messageId: number }>> {
    const sent: Array<{ chatId: string; messageId: number }> = [];
    for (const chatId of await this.access.allowedIds()) {
      try {
        const m = await this.bot!.api.sendMessage(chatId, text, { ...HTML, ...(markup ? { reply_markup: markup(chatId) } : {}) });
        sent.push({ chatId, messageId: m.message_id });
      } catch (err) {
        this.warn(`sendMessage failed (chat ${chatId})`, err);
      }
    }
    return sent;
  }

  // --- domen hodisalari ------------------------------------------------------------------------

  private async onEvent(e: DomainEvent): Promise<void> {
    switch (e.type) {
      case 'approval.created':
        return this.onApprovalCreated(e.approvalId);
      case 'approval.resolved':
        return this.onApprovalResolved(e.approvalId);
      case 'sessions.changed':
        return this.onSessionsChanged(e.refs);
      case 'machine.changed':
        return this.onMachineChanged(e.machineId);
      case 'limits.changed':
        this.limitsChain = this.limitsChain.then(() => this.evaluateLimits()).catch((err: unknown) => this.warn('limit alert failed', err));
        return;
      case 'command.changed':
        return this.onCommandChanged(e.commandId);
      case 'message.changed':
        return e.created ? this.onMessageCreated(e.messageId) : undefined;
      case 'usage.recorded':
        return;
    }
  }

  /** Savol turidagi hamkasb xabari (sukut o'chiq: guruhda `telegramQuestions`). Matn yuborilmaydi: faqat mavzu (redakt qilingan), rol va guruh. */
  private async onMessageCreated(id: string): Promise<void> {
    if (!this.messaging) return;
    const m = await this.messaging.getMessageDto(id);
    if (!m || m.kind !== 'question' || m.fromRole === 'owner') return;
    if (this.notifiedBatches.has(m.batchId)) return; // broadcast: bitta xabar
    const cfg = await this.messaging.groupConfigFor(m.groupKey);
    if (!cfg.enabled || !cfg.telegramQuestions) return;
    this.notifiedBatches.add(m.batchId);
    if (this.notifiedBatches.size > 500) {
      const oldest = this.notifiedBatches.values().next().value;
      if (oldest !== undefined) this.notifiedBatches.delete(oldest);
    }
    await this.send(formatSessionQuestion({ fromRole: m.fromRole, fromLabel: m.fromLabel, toTarget: m.toTarget, subject: m.subject }));
  }

  private async onApprovalCreated(approvalId: string): Promise<void> {
    const dto = await this.approvals.getDto(approvalId);
    if (dto.status !== 'pending') return;
    const lockdown = (await this.lockdown.state()).enabled;
    const sent = await this.send(this.fmt(dto, lockdown), (chatId) => this.mainKeyboard(dto, chatId, lockdown));
    for (const s of sent) this.trackMessage(approvalId, s.chatId, s.messageId, dto.kind);
    // Yuborish davomida hal bo'lib qolgan bo'lishi mumkin (resolved hodisasi xabar yozilmasdan oldin kelgan).
    const now = await this.approvals.getDto(approvalId);
    if (now.status !== 'pending') await this.onApprovalResolved(approvalId);
  }

  private async onApprovalResolved(approvalId: string): Promise<void> {
    const msgs = this.approvalMessages.get(approvalId);
    if (!msgs) return;
    const dto = await this.approvals.getDto(approvalId);
    if (dto.status === 'pending') return;
    this.approvalMessages.delete(approvalId);
    this.questionFlows.delete(approvalId);
    for (const [chatId, messageId] of msgs) await this.editApproval(chatId, messageId, dto, false);
  }

  private async onSessionsChanged(refs: Parameters<SessionsV1Service['findByRefs']>[0]): Promise<void> {
    for (const s of await this.sessions.findByRefs(refs)) {
      const kind = this.gate.observe(s.id, s.status);
      if (s.status !== 'done') this.doneNotices.cancel(s.id); // sessiya qayta ishga tushdi: kutilayotgan "tugadi" bekor
      if (!kind) continue;
      if (kind === 'done') {
        // Kechiktirilgan: `Stop` faqat navbat tugashi, Claude o'zi qayta boshlashi mumkin.
        this.doneNotices.schedule(s.id, () => {
          void this.sendDoneNotice(s.id).catch((err: unknown) => this.logger.warn(`done notice failed (${s.id}): ${this.scrub(errMessage(err))}`));
        });
        continue;
      }
      await this.sendSessionNotice(s, kind);
    }
  }

  /** Kechikishdan keyin: sessiya hamon `done` bo'lsagina xabar yuboradi (gate.admit aynan shu paytda). */
  private async sendDoneNotice(sessionId: string): Promise<void> {
    if (this.stopping) return;
    let s: SessionDto;
    try {
      s = await this.sessions.get(sessionId);
    } catch (err) {
      if (err instanceof NotFoundException) return; // sessiya o'chirilgan
      throw err;
    }
    if (s.status !== 'done') return;
    await this.sendSessionNotice(s, 'done');
  }

  private async sendSessionNotice(s: SessionDto, kind: SessionNoticeKind): Promise<void> {
    if (s.staleSince !== null || s.endedAt !== null) return;
    const machine = await this.machines.findById(s.machineId);
    if (!machine?.online) return; // faqat online mashinadagi sessiyalar
    if (!this.gate.admit(s.id, kind, Date.now(), { notifyDone: this.prefs.notifyDone, mutedUntil: this.prefs.mutedUntil })) return;
    const gitKb = kind === 'done' ? await this.gitDoneKeyboard(s.id, s.projectId) : null;
    await this.send(formatSessionNotice(s, kind), gitKb ?? undefined);
  }

  private async onMachineChanged(machineId: string): Promise<void> {
    const m = await this.machines.findById(machineId);
    if (!m) return;
    const name = m.displayName ?? m.hostname ?? m.slug;
    this.machineNames.set(machineId, name);
    if (this.watch.observe(machineId, m.online, Date.now()) === 'back_online') await this.send(formatMachineOnline(name));
  }

  /** Davriy: 2 daqiqadan beri offline mashinalar uchun BIR martalik ogohlantirish. */
  async checkMachines(now: number = Date.now()): Promise<void> {
    for (const id of this.watch.due(now)) {
      const m = await this.machines.findById(id);
      if (m?.online) continue; // oraliqda qaytgan (observe hali ulgurmagan bo'lsa ham)
      const name = this.machineNames.get(id) ?? id;
      await this.send(formatMachineOffline(name, new Date(now - this.options.machineOfflineAfterMs), new Date(now)));
    }
  }

  private async evaluateLimits(): Promise<void> {
    const limits = await this.limits.current();
    const { alerts, state } = decideLimitAlerts(limits, this.prefs.limitAlerts);
    if (alerts.length > 0) {
      // Avval holat saqlanadi: yuborish o'rtasida yiqilsa ham qayta-qayta ogohlantirmaydi.
      await this.updatePrefs((p) => ({ ...p, limitAlerts: state }));
      for (const a of alerts) await this.send(formatLimitAlert(a));
    }
    // 3.1: 5 soatlik oyna ~30 daqiqada tugashi bashorati (oyna uchun bir marta)
    const now = new Date();
    const f = decideForecastAlert(limits.fiveHour, this.prefs.forecastAlerts ?? {}, now);
    if (f.alert) {
      await this.updatePrefs((p) => ({ ...p, forecastAlerts: f.state }));
      await this.send(formatForecastAlert(f.alert, now));
    }
  }

  private async updatePrefs(fn: (p: TelegramPrefs) => TelegramPrefs): Promise<void> {
    this.prefs = fn(this.prefs);
    const snapshot = this.prefs;
    const task = this.prefsChain.then(() => this.access.savePrefs(snapshot));
    this.prefsChain = task.catch((err: unknown) => this.warn('prefs save failed', err));
    await task.catch(() => undefined);
  }
}
