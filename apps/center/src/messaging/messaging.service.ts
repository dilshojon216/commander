import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { MESSAGE_LIMITS, renderInboxBlock } from '@commander/contracts';
import type {
  FrameMessage,
  GroupDto,
  GroupMember,
  ListGroupsResponse,
  ListMessagesResponse,
  MailboxCall,
  MailboxReplyPayload,
  MailboxRequestPayload,
  MessageDto,
  MessageErrorCode,
  MessageKind,
  MessagingSettings,
  Peer,
  RoleSource,
  Rule,
  SendResult,
  TextResult,
} from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { CommandsService } from '../commands/commands.service.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { baseKeyOf, effectiveGroupKey, guessRole, resolveRecipients, sendLimitKey, shortIdOf } from './messaging-logic.js';
import type { Member } from './messaging-logic.js';

const GLOBAL_SETTING = 'messaging.enabled';
const SWEEP_MS = 60 * 60_000;
/** Uyg'otish buyrug'i matni QAT'IY (yuboruvchi matni hech qachon prompt'ga tushmaydi: injection kanali kengaymasin). */
export const WAKE_PROMPT = (n: number): string => `Sizga ${n} ta yangi xabar bor: commander_inbox ni o'qing`;
const WAKE_STATUSES = new Set(['idle', 'waiting', 'done']);

/** Biznes xatosi: agentga `{ok:false, error}` bo'lib, REST'da 4xx bo'lib qaytadi. */
export class MessagingError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Boshqa modullar (orkestratsiya, 3.9) o'z `op`larini pochta RPC'siga ulaydi (modul sikli yo'q). Xato: `MessagingError`. */
export interface MailboxCallExtension {
  ops: ReadonlySet<string>;
  handle(machineId: string, deviceId: string, claudeSessionId: string, call: MailboxCall): Promise<unknown>;
}

export interface MessagingActor {
  deviceId: string | null;
  actorKind: AuditActorKind;
  ip: string | null;
}

interface SessionCtx {
  sessionId: string;
  claudeSessionId: string;
  machineId: string;
  machineName: string;
  kind: string;
  status: string;
  projectName: string;
  projectPath: string | null;
  groupKey: string | null;
  role: string | null;
  roleSource: RoleSource | null;
}

interface MemberRow {
  id: string;
  claude_session_id: string;
  machine_id: string;
  machine_name: string;
  cwd: string;
  kind: string;
  status: string;
  project_name: string;
  project_path: string | null;
  base_key: string;
  group_key: string;
  role: string | null;
  role_source: 'owner' | 'session' | null;
  task_key: string | null;
  unread: number;
}

interface GroupConfigRow {
  group_key: string;
  enabled: boolean;
  auto_wake: boolean;
  telegram_questions: boolean;
  context: string;
  context_updated_at: Date | null;
  rules: Rule[];
}

interface MessageRow {
  id: string;
  batch_id: string;
  group_key: string;
  from_session_id: string | null;
  from_role: string;
  from_label: string;
  to_session_id: string;
  to_role: string | null;
  to_target: string;
  kind: MessageKind;
  subject: string;
  body: string;
  reply_to: string | null;
  status: 'pending' | 'delivered' | 'read';
  created_at: Date;
  delivered_at: Date | null;
  read_at: Date | null;
  to_machine: string;
  to_claude: string;
}

const MEMBERS_SQL = `
  SELECT s.id, s.claude_session_id, s.machine_id, s.cwd, s.kind, s.status,
         COALESCE(m.display_name, m.hostname, m.slug) AS machine_name,
         COALESCE(p.name, s.project) AS project_name, p.path AS project_path,
         COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text) AS base_key,
         COALESCE('workspace:' || l.workspace, COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text)) AS group_key,
         r.role, r.source AS role_source,
         (SELECT t.task_key FROM session_task_spans t WHERE t.machine_id = s.machine_id AND t.session_id = s.claude_session_id AND t.ended_at IS NULL LIMIT 1) AS task_key,
         (SELECT count(*)::int FROM session_messages x WHERE x.to_session_id = s.id AND x.read_at IS NULL AND x.delivered_at IS NULL) AS unread
    FROM sessions s
    JOIN machines m ON m.id = s.machine_id
    JOIN projects p ON p.id = s.project_id
    LEFT JOIN project_links l ON l.base_key = COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text)
    LEFT JOIN session_roles r ON r.session_id = s.id
   WHERE s.ended_at IS NULL AND s.status <> 'ended'`;

const MESSAGE_SQL = `
  SELECT x.*, COALESCE(m.display_name, m.hostname, m.slug) AS to_machine, s.claude_session_id AS to_claude
    FROM session_messages x
    JOIN sessions s ON s.id = x.to_session_id
    JOIN machines m ON m.id = s.machine_id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toMember(r: MemberRow): Member & { row: MemberRow } {
  return { sessionId: r.id, claudeSessionId: r.claude_session_id, role: r.role ?? guessRole({ name: r.project_name, path: r.project_path ?? r.cwd }), row: r };
}

export function toMessageDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    groupKey: r.group_key,
    batchId: r.batch_id,
    fromSessionId: r.from_session_id,
    fromRole: r.from_role,
    fromLabel: r.from_label,
    toSessionId: r.to_session_id,
    toRole: r.to_role,
    toLabel: `${r.to_machine}/${shortIdOf(r.to_claude)}`,
    toTarget: r.to_target,
    kind: r.kind,
    subject: r.subject,
    body: r.body,
    replyTo: r.reply_to,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    deliveredAt: iso(r.delivered_at),
    readAt: iso(r.read_at),
  };
}

const toFrame = (r: MessageRow): FrameMessage => ({
  id: r.id,
  fromRole: r.from_role,
  fromLabel: r.from_label,
  kind: r.kind,
  subject: r.subject,
  body: r.body,
  replyTo: r.reply_to,
  createdAt: r.created_at,
});

/**
 * Sessiyalararo pochta qutisi (task 2.10). Xavfsizlik invariantlari (testlar tekshiradi):
 *  - guruh tashqarisiga hech narsa chiqmaydi (a'zolar `group_key` bo'yicha olinadi);
 *  - guruh yoqilmagan (sukut) yoki global o'chiq bo'lsa: yuborish/o'qish rad, hook'lar jim bo'sh;
 *  - matn redakt + cheklov markazda ham; qabul qiluvchiga faqat `renderInboxBlock` ramkasi bilan;
 *  - har yuborish `audit_log`ga (matn EMAS) va xabar bilan BIR tranzaksiyada;
 *  - uyg'otish faqat qat'iy matn bilan va faqat auto-wake yoqilgan guruhda, tezligi cheklangan.
 */
@Injectable()
export class MessagingService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(MessagingService.name);
  private readonly sendLimiter = new FixedWindowLimiter(MESSAGE_LIMITS.sendLimit, MESSAGE_LIMITS.sendWindowMs);
  private readonly lastWake = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly callExtensions = new Set<MailboxCallExtension>();
  /** `deliver` (UserPromptSubmit) javobiga qo'shimcha blok (qarorlar jurnali, 6.3). Xato = e'tiborsiz (fail-safe). */
  private readonly deliverExtras = new Set<(machineId: string, claudeSessionId: string) => Promise<string | null>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly bus: RealtimeBus,
    private readonly dispatch: AgentDispatchService,
    private readonly commands: CommandsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sweep().catch((err: unknown) => this.logger.warn(`retention sweep failed: ${err instanceof Error ? err.message : String(err)}`));
    this.sweepTimer = setInterval(() => void this.sweep().catch((err: unknown) => this.logger.warn(`retention sweep failed: ${err instanceof Error ? err.message : String(err)}`)), SWEEP_MS);
    this.sweepTimer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** 30 kundan eski xabarlar o'chiriladi. */
  async sweep(): Promise<number> {
    // CTE: TypeORM DELETE...RETURNING uchun `[rows, count]` qaytaradi; SELECT esa oddiy qatorlar.
    const rows: Array<{ n: number }> = await this.dataSource.query(
      `WITH d AS (DELETE FROM session_messages WHERE created_at < now() - ($1::int * interval '1 day') RETURNING 1) SELECT count(*)::int AS n FROM d`,
      [MESSAGE_LIMITS.retentionDays],
    );
    return rows[0]?.n ?? 0;
  }

  // --- sozlamalar -----------------------------------------------------------------------------

  async globalEnabled(): Promise<boolean> {
    const rows: Array<{ value: { enabled?: unknown } }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [GLOBAL_SETTING]);
    return rows[0]?.value?.enabled !== false; // sukut: yoqilgan (guruh darajasida o'chiq)
  }

  async setGlobalEnabled(enabled: boolean, actor: MessagingActor): Promise<MessagingSettings> {
    await this.dataSource.transaction(async (m) => {
      await m.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [GLOBAL_SETTING, JSON.stringify({ enabled })]);
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.global.set', details: { enabled }, ip: actor.ip }, m);
    });
    return { enabled };
  }

  private async groupConfig(groupKey: string, m: EntityManager | DataSource = this.dataSource): Promise<GroupConfigRow> {
    const rows: GroupConfigRow[] = await m.query(`SELECT * FROM messaging_groups WHERE group_key = $1`, [groupKey]);
    return rows[0] ?? { group_key: groupKey, enabled: false, auto_wake: false, telegram_questions: false, context: '', context_updated_at: null, rules: [] };
  }

  /** Guruh va global kill-switch ikkalasi yoqilgan bo'lsa `true`. */
  private async isEnabled(groupKey: string): Promise<boolean> {
    return (await this.globalEnabled()) && (await this.groupConfig(groupKey)).enabled;
  }

  // --- sessiya konteksti -----------------------------------------------------------------------

  private async sessionCtx(machineId: string, claudeSessionId: string): Promise<SessionCtx | null> {
    const rows: MemberRow[] = await this.dataSource.query(`${MEMBERS_SQL} AND s.machine_id = $1 AND s.claude_session_id = $2`, [machineId, claudeSessionId]);
    const r = rows[0];
    if (r) {
      return {
        sessionId: r.id,
        claudeSessionId: r.claude_session_id,
        machineId: r.machine_id,
        machineName: r.machine_name,
        kind: r.kind,
        status: r.status,
        projectName: r.project_name,
        projectPath: r.project_path,
        groupKey: r.group_key,
        role: r.role ?? guessRole({ name: r.project_name, path: r.project_path ?? r.cwd }),
        roleSource: r.role ? r.role_source : guessRole({ name: r.project_name, path: r.project_path ?? r.cwd }) ? 'guess' : null,
      };
    }
    // Loyihasiz (cwd noma'lum) yoki tugagan sessiya: guruhsiz.
    const bare: Array<{ id: string; kind: string; status: string; machine_name: string; project: string }> = await this.dataSource.query(
      `SELECT s.id, s.kind, s.status, COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, s.project
         FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
      [machineId, claudeSessionId],
    );
    const b = bare[0];
    if (!b) return null;
    return { sessionId: b.id, claudeSessionId, machineId, machineName: b.machine_name, kind: b.kind, status: b.status, projectName: b.project, projectPath: null, groupKey: null, role: null, roleSource: null };
  }

  private async members(groupKey: string, m: EntityManager | DataSource = this.dataSource): Promise<Array<Member & { row: MemberRow }>> {
    const rows: MemberRow[] = await m.query(`SELECT * FROM (${MEMBERS_SQL}) g WHERE g.group_key = $1 ORDER BY g.machine_name, g.project_name, g.claude_session_id`, [groupKey]);
    return rows.map(toMember);
  }

  // --- agent so'rovlari (mailbox RPC) ----------------------------------------------------------

  registerCallExtension(ext: MailboxCallExtension): () => void {
    this.callExtensions.add(ext);
    return () => void this.callExtensions.delete(ext);
  }

  /** Boshqa modul `deliver` javobiga ramkali blok qo'shadi (bir martalik mantiq o'sha modulda). */
  registerDeliverExtra(fn: (machineId: string, claudeSessionId: string) => Promise<string | null>): () => void {
    this.deliverExtras.add(fn);
    return () => void this.deliverExtras.delete(fn);
  }

  private async withDeliverExtras(machineId: string, claudeSessionId: string, data: unknown): Promise<unknown> {
    const base = typeof data === 'object' && data !== null ? (data as Partial<TextResult>) : {};
    const blocks: string[] = [];
    for (const fn of this.deliverExtras) {
      try {
        const t = await fn(machineId, claudeSessionId);
        if (t) blocks.push(t);
      } catch (err) {
        this.logger.warn(`deliver extra failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (blocks.length === 0) return data;
    return { text: [...blocks, ...(base.text ? [base.text] : [])].join('\n\n'), count: (base.count ?? 0) + blocks.length, remaining: base.remaining ?? 0 } satisfies TextResult;
  }

  async handleMailbox(machineId: string, deviceId: string, req: MailboxRequestPayload): Promise<MailboxReplyPayload> {
    try {
      let data = await this.dispatchCall(machineId, deviceId, req.claudeSessionId, req.call);
      if (req.call.op === 'deliver' && this.deliverExtras.size > 0) data = await this.withDeliverExtras(machineId, req.claudeSessionId, data);
      return { reqId: req.reqId, ok: true, data };
    } catch (err) {
      if (err instanceof MessagingError) return { reqId: req.reqId, ok: false, error: { code: err.code, message: err.message.slice(0, 300) } };
      this.logger.error(`mailbox ${req.call.op} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { reqId: req.reqId, ok: false, error: { code: 'internal', message: 'Center vaqtincha ishlay olmadi' } };
    }
  }

  private async dispatchCall(machineId: string, deviceId: string, claudeSessionId: string, call: MailboxCall): Promise<unknown> {
    for (const ext of this.callExtensions) if (ext.ops.has(call.op)) return ext.handle(machineId, deviceId, claudeSessionId, call);
    const ctx = await this.sessionCtx(machineId, claudeSessionId);
    if (!ctx) throw new MessagingError('session_unknown', "Center bu sessiyani hali bilmaydi (birinchi hook hodisasi kelgach urinib ko'ring)");
    const silent = call.op === 'deliver' || call.op === 'stop_check';
    if (!ctx.groupKey || !(await this.isEnabled(ctx.groupKey))) {
      if (silent) return { text: null, count: 0, remaining: 0 } satisfies TextResult;
      if (!ctx.groupKey) throw new MessagingError('group_unavailable', "Bu sessiya loyihaga bog'lanmagan (cwd ma'lum emas): guruh yo'q");
      throw new MessagingError('messaging_disabled', "Sessiyalararo xabar bu guruhda o'chiq (egasi dashboard'dan yoqadi)");
    }
    const groupKey = ctx.groupKey;
    switch (call.op) {
      case 'send':
        return this.agentSend(ctx, groupKey, deviceId, call);
      case 'inbox':
        return this.inbox(ctx, call.unreadOnly ?? true);
      case 'peers':
        return this.peers(ctx, groupKey);
      case 'context': {
        const cfg = await this.groupConfig(groupKey);
        return { context: cfg.context, enabled: true };
      }
      case 'set_role':
        return this.setRoleBySession(ctx, call.role, deviceId);
      case 'deliver':
        return this.deliverPending(ctx, MESSAGE_LIMITS.pushMaxBytes, false);
      case 'stop_check':
        return this.deliverPending(ctx, MESSAGE_LIMITS.pushMaxBytes, true, groupKey);
      default:
        throw new MessagingError('invalid_request', `Noma'lum operatsiya: ${call.op}`);
    }
  }

  private async agentSend(ctx: SessionCtx, groupKey: string, deviceId: string, call: Extract<MailboxCall, { op: 'send' }>): Promise<SendResult> {
    if (this.sendLimiter.hit(sendLimitKey(ctx.sessionId)) > MESSAGE_LIMITS.sendLimit) {
      throw new MessagingError('rate_limited', `Juda tez-tez xabar: ${Math.round(MESSAGE_LIMITS.sendWindowMs / 60_000)} daqiqada eng ko'pi ${MESSAGE_LIMITS.sendLimit} ta`);
    }
    return this.sendMessage({
      groupKey,
      from: { sessionId: ctx.sessionId, role: ctx.role ?? 'unknown', label: `${ctx.machineName}/${shortIdOf(ctx.claudeSessionId)}` },
      to: call.to,
      kind: call.kind,
      subject: call.subject,
      body: call.body,
      replyTo: call.replyTo ?? null,
      actor: { deviceId, actorKind: 'agentd', ip: null },
    });
  }

  // --- yuborish (agent va egasi uchun umumiy) ---------------------------------------------------

  async sendMessage(i: {
    groupKey: string;
    /** `null` = egasi (dashboard). */
    from: { sessionId: string; role: string; label: string } | null;
    to: string;
    kind: MessageKind;
    subject: string;
    body: string;
    replyTo: string | null;
    actor: MessagingActor;
  }): Promise<SendResult> {
    const subject = redactAndCap(i.subject.replace(/\s+/g, ' ').trim(), MESSAGE_LIMITS.subjectMaxChars);
    const body = redactAndCap(i.body, MESSAGE_LIMITS.bodyMaxChars);
    if (subject.length === 0 || body.trim().length === 0) throw new MessagingError('invalid_request', "Mavzu va matn bo'sh bo'lmasligi kerak");
    const fromRole = i.from ? i.from.role : 'owner';
    const fromLabel = i.from ? i.from.label : 'dashboard';

    const batchId = randomUUID();
    const result = await this.dataSource.transaction(async (m) => {
      const cfg = await this.groupConfig(i.groupKey, m);
      if (!cfg.enabled || !(await this.globalEnabled())) throw new MessagingError('messaging_disabled', "Sessiyalararo xabar bu guruhda o'chiq");
      const members = await this.members(i.groupKey, m);
      const res = resolveRecipients({ to: i.to, members, fromSessionId: i.from?.sessionId ?? null, rules: cfg.rules, kind: i.kind, subject });
      if (!res.ok) throw new MessagingError(res.code, res.message);
      if (i.replyTo) {
        const ok: unknown[] = await m.query(`SELECT 1 FROM session_messages WHERE id = $1 AND group_key = $2`, [i.replyTo, i.groupKey]);
        if (ok.length === 0) throw new MessagingError('invalid_request', "replyTo shu guruhdagi xabarga ishora qilishi kerak");
      }
      const ids: string[] = [];
      for (const r of res.recipients) {
        const row = members.find((x) => x.sessionId === r.sessionId);
        const out: Array<{ id: string }> = await m.query(
          `INSERT INTO session_messages (batch_id, group_key, from_session_id, from_role, from_label, to_session_id, to_role, to_target, kind, subject, body, reply_to, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, date_trunc('milliseconds', clock_timestamp())) RETURNING id`,
          [batchId, i.groupKey, i.from?.sessionId ?? null, fromRole, fromLabel, r.sessionId, row?.role ?? null, res.target, i.kind, subject, body, i.replyTo],
        );
        ids.push((out[0] as { id: string }).id);
      }
      await this.audit.record(
        {
          actorDeviceId: i.actor.deviceId,
          actorKind: i.actor.actorKind,
          action: 'message.send',
          target: i.groupKey,
          // Matn YOZILMAYDI: faqat kim, qayerga, tur va o'lchamlar.
          details: { batchId, from: fromLabel, fromRole, to: res.target, kind: i.kind, recipients: res.recipients.length, subjectChars: subject.length, bodyChars: body.length },
          ip: i.actor.ip,
        },
        m,
      );
      return { ids, recipients: res.recipients.map((r) => r.sessionId), target: res.target, autoWake: cfg.auto_wake };
    });

    for (const id of result.ids) this.bus.publish({ type: 'message.changed', messageId: id, created: true });
    if (result.autoWake) void this.wake(result.recipients, batchId).catch((err: unknown) => this.logger.warn(`wake failed: ${err instanceof Error ? err.message : String(err)}`));
    return { messageIds: result.ids, recipients: result.ids.length, target: result.target };
  }

  // --- o'qish ----------------------------------------------------------------------------------

  /** Yetkazilmagan (kontekstga tushmagan, o'qilmagan) xabarlarni ramkaga o'raydi; kiritilganlarini `delivered` qiladi. */
  private async deliverPending(ctx: SessionCtx, maxBytes: number, requireAutoWake: boolean, groupKey?: string): Promise<TextResult> {
    if (requireAutoWake && groupKey && !(await this.groupConfig(groupKey)).auto_wake) return { text: null, count: 0, remaining: 0 };
    return this.dataSource.transaction(async (m) => {
      // `FOR UPDATE`: ikki hook bir vaqtda kelsa ham xabar bir marta yetkaziladi (Stop-hook sikliga qarshi).
      const rows: MessageRow[] = await m.query(
        `${MESSAGE_SQL} WHERE x.to_session_id = $1 AND x.read_at IS NULL AND x.delivered_at IS NULL ORDER BY x.created_at, x.id LIMIT ${MESSAGE_LIMITS.inboxMaxItems + 1} FOR UPDATE OF x`,
        [ctx.sessionId],
      );
      const block = renderInboxBlock(rows.map(toFrame), maxBytes);
      if (block.includedIds.length > 0) {
        await m.query(`UPDATE session_messages SET delivered_at = now(), status = 'delivered' WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [block.includedIds]);
      }
      const count = block.includedIds.length;
      // `rows` LIMIT+1 gacha: "remaining" haqiqiy qoldiq emas, balki kiritilmaganlar soni (kamida)
      this.afterCommit(block.includedIds);
      return { text: block.text, count, remaining: block.remaining };
    });
  }

  private async inbox(ctx: SessionCtx, unreadOnly: boolean): Promise<TextResult> {
    return this.dataSource.transaction(async (m) => {
      const rows: MessageRow[] = await m.query(
        `${MESSAGE_SQL} WHERE x.to_session_id = $1 ${unreadOnly ? 'AND x.read_at IS NULL' : ''} ORDER BY x.created_at, x.id LIMIT ${MESSAGE_LIMITS.inboxMaxItems}`,
        [ctx.sessionId],
      );
      const block = renderInboxBlock(rows.map(toFrame), MESSAGE_LIMITS.inboxMaxBytes);
      if (block.includedIds.length > 0) {
        await m.query(`UPDATE session_messages SET read_at = now(), delivered_at = COALESCE(delivered_at, now()), status = 'read' WHERE id = ANY($1::uuid[])`, [block.includedIds]);
      }
      this.afterCommit(block.includedIds);
      return { text: block.text ?? (unreadOnly ? "Yangi xabar yo'q." : "Xabar yo'q."), count: block.includedIds.length, remaining: block.remaining };
    });
  }

  /** Tranzaksiya tugagach (keyingi tick) klientlarga `message.updated`. */
  private afterCommit(ids: string[]): void {
    if (ids.length === 0) return;
    setImmediate(() => {
      for (const id of ids) this.bus.publish({ type: 'message.changed', messageId: id, created: false });
    });
  }

  private async peers(ctx: SessionCtx, groupKey: string): Promise<{ group: string; enabled: boolean; autoWake: boolean; peers: Peer[] }> {
    const cfg = await this.groupConfig(groupKey);
    const members = await this.members(groupKey);
    const peers: Peer[] = members.map((mb) => {
      const r = mb.row;
      return {
        shortId: shortIdOf(r.claude_session_id),
        role: mb.role,
        roleSource: r.role ? r.role_source : mb.role ? 'guess' : null,
        machine: r.machine_name,
        project: r.project_name,
        status: r.status,
        kind: r.kind,
        task: r.task_key,
        self: r.id === ctx.sessionId,
      };
    });
    return { group: groupKey, enabled: cfg.enabled, autoWake: cfg.auto_wake, peers };
  }

  private async setRoleBySession(ctx: SessionCtx, role: string, deviceId: string): Promise<{ role: string }> {
    const existing: Array<{ source: string }> = await this.dataSource.query(`SELECT source FROM session_roles WHERE session_id = $1`, [ctx.sessionId]);
    if (existing[0]?.source === 'owner') throw new MessagingError('forbidden_role', "Rolni egasi (dashboard) belgilagan: sessiya o'zgartira olmaydi");
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO session_roles (session_id, role, source, updated_at) VALUES ($1, $2, 'session', now())
         ON CONFLICT (session_id) DO UPDATE SET role = EXCLUDED.role, source = 'session', updated_at = now()`,
        [ctx.sessionId, role],
      );
      await this.audit.record({ actorDeviceId: deviceId, actorKind: 'agentd', action: 'messaging.role.set', target: ctx.sessionId, details: { role, by: 'session' } }, m);
    });
    return { role };
  }

  // --- uyg'otish (bg sessiya, auto-wake) ---------------------------------------------------------

  private async wake(sessionIds: string[], batchId: string): Promise<void> {
    for (const sid of sessionIds) {
      const rows: Array<{ id: string; kind: string; status: string; machine_id: string; ended_at: Date | null; pending: number }> = await this.dataSource.query(
        `SELECT s.id, s.kind, s.status, s.machine_id, s.ended_at,
                (SELECT count(*)::int FROM session_messages x WHERE x.to_session_id = s.id AND x.read_at IS NULL AND x.delivered_at IS NULL) AS pending
           FROM sessions s WHERE s.id = $1`,
        [sid],
      );
      const s = rows[0];
      if (!s || s.ended_at !== null || s.kind !== 'bg' || !WAKE_STATUSES.has(s.status) || s.pending === 0) continue;
      const now = Date.now();
      if (now - (this.lastWake.get(sid) ?? 0) < MESSAGE_LIMITS.wakeMinGapMs) continue;
      const deviceId = this.dispatch.deviceIdFor(s.machine_id);
      if (!deviceId) continue; // agentd offline: xabar pochtada turadi
      this.lastWake.set(sid, now);
      if (this.lastWake.size > 5000) for (const k of this.lastWake.keys()) { this.lastWake.delete(k); if (this.lastWake.size < 2500) break; }
      try {
        const out = await this.commands.create({ type: 'session.prompt', sessionId: sid, text: WAKE_PROMPT(s.pending) }, { deviceId, actorKind: 'system', ip: null }, `wake-${sid.slice(0, 8)}-${batchId.slice(0, 8)}`);
        await this.audit.record({ actorDeviceId: deviceId, actorKind: 'system', action: 'message.wake', target: sid, details: { batchId, commandId: out.command.id, status: out.command.status, pending: s.pending } });
      } catch (err) {
        this.logger.warn(`auto-wake skipped for ${sid.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- egasi (REST) ------------------------------------------------------------------------------

  async getMessageDto(id: string): Promise<MessageDto | null> {
    const rows: MessageRow[] = await this.dataSource.query(`${MESSAGE_SQL} WHERE x.id = $1`, [id]);
    return rows[0] ? toMessageDto(rows[0]) : null;
  }

  async groupConfigFor(groupKey: string): Promise<{ enabled: boolean; telegramQuestions: boolean }> {
    const c = await this.groupConfig(groupKey);
    return { enabled: c.enabled && (await this.globalEnabled()), telegramQuestions: c.telegram_questions };
  }

  async settings(): Promise<MessagingSettings> {
    return { enabled: await this.globalEnabled() };
  }

  async listGroups(): Promise<ListGroupsResponse> {
    const projects: Array<{ id: string; name: string; path: string; repo_key: string | null; base_key: string; workspace: string | null }> = await this.dataSource.query(
      `SELECT p.id, p.name, p.path, p.repo_key, COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text) AS base_key, l.workspace
         FROM projects p LEFT JOIN project_links l ON l.base_key = COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text)`,
    );
    const live: MemberRow[] = await this.dataSource.query(MEMBERS_SQL);
    const configs: GroupConfigRow[] = await this.dataSource.query(`SELECT * FROM messaging_groups`);
    const cfgBy = new Map(configs.map((c) => [c.group_key, c]));

    const groups = new Map<string, { baseKeys: Set<string>; workspace: string | null; labels: string[] }>();
    const ensure = (key: string, workspace: string | null): { baseKeys: Set<string>; workspace: string | null; labels: string[] } => {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { baseKeys: new Set(), workspace, labels: [] }));
      return g;
    };
    for (const r of live) ensure(r.group_key, r.group_key.startsWith('workspace:') ? r.group_key.slice(10) : null);
    for (const c of configs) ensure(c.group_key, c.group_key.startsWith('workspace:') ? c.group_key.slice(10) : null);
    const linkRows: Array<{ base_key: string; workspace: string }> = await this.dataSource.query(`SELECT base_key, workspace FROM project_links`);
    for (const l of linkRows) ensure(`workspace:${l.workspace}`, l.workspace).baseKeys.add(l.base_key);
    for (const p of projects) {
      const key = effectiveGroupKey(p.base_key, p.workspace);
      const g = groups.get(key);
      if (g) {
        g.baseKeys.add(p.base_key);
        g.labels.push(p.repo_key ? p.repo_key.split('/').slice(-1)[0] ?? p.name : p.name);
      }
    }

    const out: GroupDto[] = [];
    for (const [key, g] of groups) {
      const cfg = cfgBy.get(key);
      const members: GroupMember[] = live
        .filter((r) => r.group_key === key)
        .map(toMember)
        .map((mb) => ({
          sessionId: mb.row.id,
          shortId: shortIdOf(mb.row.claude_session_id),
          machineId: mb.row.machine_id,
          machineName: mb.row.machine_name,
          projectName: mb.row.project_name,
          cwd: mb.row.cwd,
          kind: mb.row.kind,
          status: mb.row.status,
          role: mb.role,
          roleSource: mb.row.role ? mb.row.role_source : mb.role ? 'guess' : null,
          taskKey: mb.row.task_key,
          unread: mb.row.unread,
        }));
      out.push({
        key,
        label: g.workspace ? `workspace: ${g.workspace}` : (g.labels[0] ?? key),
        baseKeys: [...g.baseKeys].sort(),
        workspace: g.workspace,
        enabled: cfg?.enabled ?? false,
        autoWake: cfg?.auto_wake ?? false,
        telegramQuestions: cfg?.telegram_questions ?? false,
        rules: cfg?.rules ?? [],
        contextLength: cfg?.context.length ?? 0,
        contextUpdatedAt: iso(cfg?.context_updated_at ?? null),
        context: cfg?.context ?? '',
        members,
        unread: members.reduce((a, b) => a + b.unread, 0),
      });
    }
    out.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));

    const seen = new Set<string>();
    const linkable: ListGroupsResponse['linkable'] = [];
    for (const p of projects) {
      if (seen.has(p.base_key)) continue;
      seen.add(p.base_key);
      linkable.push({ baseKey: p.base_key, label: p.repo_key ?? p.name, workspace: p.workspace });
    }
    linkable.sort((a, b) => a.label.localeCompare(b.label));
    return { settings: await this.settings(), groups: out, linkable };
  }

  async getGroup(key: string): Promise<GroupDto> {
    const g = (await this.listGroups()).groups.find((x) => x.key === key);
    if (!g) throw new NotFoundException({ error: 'not_found', message: 'Group not found' });
    return g;
  }

  /** Egasi sozlamani o'zgartiradi. Kalit bilinmasa 404 (ixtiyoriy matn bilan qator yaratilmaydi). */
  async patchGroup(key: string, patch: { enabled?: boolean; autoWake?: boolean; telegramQuestions?: boolean }, actor: MessagingActor): Promise<GroupDto> {
    await this.getGroup(key);
    await this.dataSource.transaction(async (m) => {
      await m.query(`INSERT INTO messaging_groups (group_key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
      await m.query(
        `UPDATE messaging_groups SET enabled = COALESCE($2, enabled), auto_wake = COALESCE($3, auto_wake), telegram_questions = COALESCE($4, telegram_questions),
                updated_by_device_id = $5, updated_at = now() WHERE group_key = $1`,
        [key, patch.enabled ?? null, patch.autoWake ?? null, patch.telegramQuestions ?? null, actor.deviceId],
      );
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.group.update', target: key, details: { ...patch }, ip: actor.ip }, m);
    });
    return this.getGroup(key);
  }

  async putContext(key: string, context: string, actor: MessagingActor): Promise<GroupDto> {
    await this.getGroup(key);
    const clean = redactAndCap(context, MESSAGE_LIMITS.contextMaxChars);
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO messaging_groups (group_key, context, context_updated_at) VALUES ($1, $2, now())
         ON CONFLICT (group_key) DO UPDATE SET context = EXCLUDED.context, context_updated_at = now(), updated_by_device_id = $3, updated_at = now()`,
        [key, clean, actor.deviceId],
      );
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.context.update', target: key, details: { chars: clean.length }, ip: actor.ip }, m);
    });
    return this.getGroup(key);
  }

  async putRules(key: string, rules: Rule[], actor: MessagingActor): Promise<GroupDto> {
    await this.getGroup(key);
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO messaging_groups (group_key, rules) VALUES ($1, $2::jsonb)
         ON CONFLICT (group_key) DO UPDATE SET rules = EXCLUDED.rules, updated_by_device_id = $3, updated_at = now()`,
        [key, JSON.stringify(rules), actor.deviceId],
      );
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.rules.update', target: key, details: { count: rules.length }, ip: actor.ip }, m);
    });
    return this.getGroup(key);
  }

  /** Egasi rolni belgilaydi (`null` = olib tashlash, taxminga qaytadi). Egasi belgilagan rolni sessiya o'zgartira olmaydi. */
  async putRole(sessionId: string, role: string | null, actor: MessagingActor): Promise<{ sessionId: string; role: string | null; roleSource: RoleSource | null }> {
    const ex: unknown[] = await this.dataSource.query(`SELECT 1 FROM sessions WHERE id = $1`, [sessionId]);
    if (ex.length === 0) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    await this.dataSource.transaction(async (m) => {
      if (role === null) await m.query(`DELETE FROM session_roles WHERE session_id = $1`, [sessionId]);
      else {
        await m.query(
          `INSERT INTO session_roles (session_id, role, source, updated_at) VALUES ($1, $2, 'owner', now())
           ON CONFLICT (session_id) DO UPDATE SET role = EXCLUDED.role, source = 'owner', updated_at = now()`,
          [sessionId, role],
        );
      }
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.role.set', target: sessionId, details: { role, by: 'owner' }, ip: actor.ip }, m);
    });
    return { sessionId, role, roleSource: role ? 'owner' : null };
  }

  async putLink(baseKey: string, workspace: string, actor: MessagingActor): Promise<ListGroupsResponse> {
    const known: unknown[] = await this.dataSource.query(`SELECT 1 FROM projects p WHERE COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text) = $1 LIMIT 1`, [baseKey]);
    if (known.length === 0) throw new NotFoundException({ error: 'not_found', message: 'No such repo/project key' });
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO project_links (base_key, workspace, created_by_device_id) VALUES ($1, $2, $3)
         ON CONFLICT (base_key) DO UPDATE SET workspace = EXCLUDED.workspace, created_by_device_id = EXCLUDED.created_by_device_id`,
        [baseKey, workspace, actor.deviceId],
      );
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.link.put', target: baseKey, details: { workspace }, ip: actor.ip }, m);
    });
    return this.listGroups();
  }

  async deleteLink(baseKey: string, actor: MessagingActor): Promise<ListGroupsResponse> {
    await this.dataSource.transaction(async (m) => {
      const del: Array<{ n: number }> = await m.query(`WITH d AS (DELETE FROM project_links WHERE base_key = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [baseKey]);
      if ((del[0]?.n ?? 0) === 0) throw new NotFoundException({ error: 'not_found', message: 'No such link' });
      await this.audit.record({ actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'messaging.link.delete', target: baseKey, ip: actor.ip }, m);
    });
    return this.listGroups();
  }

  async ownerSend(i: { key: string; to: string; kind: MessageKind; subject: string; body: string; replyTo?: string | undefined }, actor: MessagingActor): Promise<SendResult> {
    await this.getGroup(i.key);
    return this.sendMessage({ groupKey: i.key, from: null, to: i.to, kind: i.kind, subject: i.subject, body: i.body, replyTo: i.replyTo ?? null, actor });
  }

  async listMessages(key: string, limit: number, cursor: string | undefined): Promise<ListMessagesResponse> {
    let before: { ts: string; id: string } | null = null;
    if (cursor) {
      const [ts, id] = cursor.split('|');
      if (!ts || !id || Number.isNaN(Date.parse(ts))) throw new MessagingError('invalid_request', 'Bad cursor');
      before = { ts, id };
    }
    const rows: MessageRow[] = await this.dataSource.query(
      `${MESSAGE_SQL} WHERE x.group_key = $1 AND ($2::timestamptz IS NULL OR (x.created_at, x.id) < ($2::timestamptz, $3::uuid))
        ORDER BY x.created_at DESC, x.id DESC LIMIT $4`,
      [key, before?.ts ?? null, before?.id ?? randomUUID(), limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toMessageDto), nextCursor: rows.length > limit && last ? `${last.created_at.toISOString()}|${last.id}` : null };
  }

  /** Test uchun: `baseKeyOf` bilan bir xil kalit. */
  static keyFor(p: { repoKey: string | null; projectId: string }): string {
    return baseKeyOf(p);
  }
}
