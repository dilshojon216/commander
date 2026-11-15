import { createHash } from 'node:crypto';
import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ASK_LIMITS, AskResultSchema } from '@commander/contracts';
import type { AgentControlState, AskHistoryItem, AskResponse } from '@commander/contracts';
import { UsageService } from '../api/usage.service.js';
import { redactAndCap } from '../common/redact-text.js';
import { CommandsService } from '../commands/commands.service.js';
import type { CommandActor } from '../commands/commands.service.js';
import { FixedWindowLimiter } from '../identity/common/rate-limiter.js';
import { LimitsService } from '../limits/limits.service.js';
import { buildAskContext, pickAssistantMachine, resolveSources } from './ask-context.js';
import type { AskFacts, LimitFact } from './ask-context.js';
import { SummariesService } from './summaries.service.js';
import { tashkentDay } from './summary-logic.js';

export type AskChannel = 'dashboard' | 'telegram';

export class AskError extends HttpException {
  constructor(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
    super({ error, message, ...extra }, status);
  }
}

const stripHtml = (h: string): string =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Commander'dan savol (6.2). Markaz tuzilgan ma'lumotdan (transcript YO'Q) kontekst quradi va Mac'dagi agentd'dan imzolangan
 * `assistant.ask` (haiku, vositasiz) bilan javob oladi. Tezlik chegarasi (qurilma/chat) + kunlik umumiy chegara; audit:
 * `commands` + `audit_log` (`command.*`) va `assistant_queries` (savol REDAKT qilingan, 30 kun; javob matni saqlanmaydi).
 */
@Injectable()
export class AskService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(AskService.name);
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly limiter = new FixedWindowLimiter(ASK_LIMITS.rateLimit, ASK_LIMITS.rateWindowMs);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commands: CommandsService,
    private readonly summaries: SummariesService,
    private readonly usage: UsageService,
    private readonly limits: LimitsService,
  ) {}

  /** 30 kunlik saqlash: ishga tushganda va har 6 soatda (savol bo'lmasa ham) eski yozuvlar o'chadi. */
  onModuleInit(): void {
    const run = (): void => void this.prune().catch((err: unknown) => this.logger.warn(`assistant_queries prune failed: ${err instanceof Error ? err.message : String(err)}`));
    run();
    this.pruneTimer = setInterval(run, 6 * 3600_000);
    this.pruneTimer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async ask(question: string, actor: CommandActor, channel: AskChannel, now: Date = new Date()): Promise<AskResponse> {
    const started = Date.now();
    const q = question.trim();
    if (this.limiter.hit(actor.deviceId, now.getTime()) > ASK_LIMITS.rateLimit) {
      const retry = this.limiter.retryAfterSeconds(actor.deviceId, now.getTime());
      throw new AskError(429, 'rate_limited', `Juda tez-tez so'rayapsiz; ${retry} soniyadan keyin urinib ko'ring`, { retryAfterSeconds: retry });
    }
    await this.prune().catch((err: unknown) => this.logger.warn(`assistant_queries prune failed: ${err instanceof Error ? err.message : String(err)}`));
    const today: Array<{ n: number }> = await this.dataSource.query(`SELECT count(*)::int AS n FROM assistant_queries WHERE (created_at AT TIME ZONE 'Asia/Tashkent')::date = $1::date`, [tashkentDay(now)]);
    if ((today[0]?.n ?? 0) >= ASK_LIMITS.dailyCap) throw new AskError(429, 'daily_cap', `Kunlik savol chegarasi (${ASK_LIMITS.dailyCap}) tugadi`, { retryAfterSeconds: 3600 });

    const machine = await this.pickMachine();
    if (!machine) throw new AskError(409, 'assistant_unavailable', "Yordamchi hozir mavjud emas: javob beradigan onlayn mashina (agentd `assistant` bilan) yo'q");

    const facts = await this.gatherFacts(q, now);
    const { context, catalog } = buildAskContext(facts);
    const rec: Array<{ id: string }> = await this.dataSource.query(
      `INSERT INTO assistant_queries (device_id, actor_kind, channel, question_redacted, question_sha256, question_chars, context_chars, machine_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.deviceId, actor.actorKind, channel, redactAndCap(q, ASK_LIMITS.questionMaxChars), createHash('sha256').update(q, 'utf8').digest('hex'), q.length, context.length, machine.id],
    );
    const queryId = (rec[0] as { id: string }).id;
    const fail = async (status: number, code: string, message: string): Promise<never> => {
      await this.dataSource.query(`UPDATE assistant_queries SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1`, [queryId, code]);
      throw new AskError(status, code, message);
    };

    const created = await this.commands.create({ type: 'assistant.ask', machineId: machine.id, question: q, context }, actor, undefined, now);
    await this.dataSource.query(`UPDATE assistant_queries SET command_id = $2 WHERE id = $1`, [queryId, created.command.id]);
    let cmd = created.command;
    if (cmd.status !== 'done') {
      if (cmd.status === 'rejected' || cmd.status === 'failed' || cmd.status === 'expired') return fail(409, 'assistant_unavailable', `Yordamchi bajara olmadi (${cmd.errorCode ?? cmd.status})`);
      const waited = await this.commands.waitFinished(cmd.id, ASK_LIMITS.waitMs);
      cmd = waited.command;
      if (waited.timedOut) return fail(504, 'ask_timeout', "Javob kutish muddati tugadi; keyinroq urinib ko'ring");
      if (cmd.status !== 'done') return fail(cmd.status === 'rejected' || cmd.status === 'expired' ? 409 : 502, 'ask_failed', `Yordamchi javob bera olmadi (${cmd.errorCode ?? cmd.status})`);
    }
    const parsed = AskResultSchema.safeParse(this.commands.takeAssistant(cmd.id));
    if (!parsed.success) return fail(502, 'ask_failed', "Yordamchi javobi yaroqsiz");
    const tookMs = Date.now() - started;
    await this.dataSource.query(`UPDATE assistant_queries SET status = 'done', answer_chars = $2, finished_at = now() WHERE id = $1`, [queryId, parsed.data.answer.length]);
    return { queryId, answer: parsed.data.answer, sources: resolveSources(parsed.data.sources, catalog), model: parsed.data.model, tookMs };
  }

  async history(limit: number): Promise<AskHistoryItem[]> {
    const rows: Array<{ id: string; question_redacted: string; status: 'pending' | 'done' | 'failed'; error_code: string | null; created_at: Date; finished_at: Date | null }> = await this.dataSource.query(
      `SELECT id, question_redacted, status, error_code, created_at, finished_at FROM assistant_queries ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((r) => ({ id: r.id, question: r.question_redacted, status: r.status, errorCode: r.error_code, askedAt: r.created_at.toISOString(), tookMs: r.finished_at ? r.finished_at.getTime() - r.created_at.getTime() : null }));
  }

  /** 30 kundan eski savollar o'chiriladi. */
  async prune(): Promise<void> {
    await this.dataSource.query(`DELETE FROM assistant_queries WHERE created_at < now() - ($1::int * interval '1 day')`, [ASK_LIMITS.retentionDays]);
  }

  private async pickMachine(): Promise<{ id: string } | null> {
    const pref: Array<{ value: { machineId?: unknown } }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = 'assistant.machine_id'`);
    const rows: Array<{ id: string; online: boolean; os: string | null; control: AgentControlState | null; last_seen_at: Date | null }> = await this.dataSource.query(
      `SELECT id, online, os, control, last_seen_at FROM machines WHERE status = 'active' AND merged_into_id IS NULL`,
    );
    const preferred = typeof pref[0]?.value?.machineId === 'string' ? pref[0].value.machineId : null;
    return pickAssistantMachine(
      rows
        .filter((r) => r.control?.enabled === true && r.control.centerKeyPinned && !r.control.runningAsRoot && r.control.allowProjectRead !== false)
        .map((r) => ({ id: r.id, online: r.online, os: r.os, assistant: r.control?.assistant === true, lastSeenAt: r.last_seen_at?.getTime() ?? 0 })),
      preferred,
    );
  }

  async gatherFacts(question: string, now: Date): Promise<AskFacts> {
    const db = this.dataSource;
    const [machines, sessions, taskRows, queue, reports, decisions, usage, limits, projects] = await Promise.all([
      db.query(
        `SELECT m.id, COALESCE(m.display_name, m.hostname, m.slug) AS name, m.online, m.last_seen_at,
                count(s.id) FILTER (WHERE s.ended_at IS NULL AND s.status <> 'ended')::int AS open,
                count(s.id) FILTER (WHERE s.ended_at IS NULL AND s.status = 'working')::int AS working,
                count(s.id) FILTER (WHERE s.ended_at IS NULL AND s.status = 'waiting')::int AS waiting,
                count(s.id) FILTER (WHERE s.ended_at IS NULL AND s.status = 'awaiting_approval')::int AS awaiting
           FROM machines m LEFT JOIN sessions s ON s.machine_id = m.id AND s.last_seen_at > now() - interval '12 hours'
          WHERE m.status = 'active' AND m.merged_into_id IS NULL GROUP BY m.id ORDER BY name`,
      ) as Promise<Array<{ id: string; name: string; online: boolean; last_seen_at: Date | null; open: number; working: number; waiting: number; awaiting: number }>>,
      db.query(
        `SELECT s.id, COALESCE(p.name, s.project) AS project, COALESCE(m.display_name, m.hostname, m.slug) AS machine, s.status,
                (EXTRACT(EPOCH FROM (now() - s.status_since)) / 60)::int AS since,
                (SELECT t.task_key FROM session_task_spans t WHERE t.machine_id = s.machine_id AND t.session_id = s.claude_session_id AND t.ended_at IS NULL LIMIT 1) AS task
           FROM sessions s JOIN machines m ON m.id = s.machine_id LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.ended_at IS NULL AND s.status <> 'ended' AND s.last_seen_at > now() - interval '12 hours'
          ORDER BY s.status_since DESC LIMIT 40`,
      ) as Promise<Array<{ id: string; project: string; machine: string; status: string; since: number; task: string | null }>>,
      db.query(`SELECT project_id, status, count(*)::int AS n FROM project_tasks GROUP BY project_id, status`) as Promise<Array<{ project_id: string; status: string; n: number }>>,
      db.query(`SELECT status, count(*)::int AS n FROM task_queue GROUP BY status`) as Promise<Array<{ status: string; n: number }>>,
      db.query(`SELECT id, kind, period_start::text AS period_start, text_html FROM reports ORDER BY period_start DESC, generated_at DESC LIMIT 3`) as Promise<Array<{ id: string; kind: string; period_start: string; text_html: string }>>,
      db.query(
        `SELECT d.id, d.project_id, p.name AS project, d.title, d.decision, d.created_at FROM project_decisions d LEFT JOIN projects p ON p.id = d.project_id
          WHERE d.status = 'active' ORDER BY d.created_at DESC LIMIT 8`,
      ) as Promise<Array<{ id: string; project_id: string | null; project: string | null; title: string; decision: string; created_at: Date }>>,
      this.usage.summary(now),
      this.limits.current(now),
      this.usage.projects({ limit: 25 }, now),
    ]);

    let hits = await this.summaries.search({ q: question, limit: 8 }, { any: true });
    if (hits.length === 0) hits = (await this.summaries.recent(4)).map((r) => ({ ...r, headline: '', rank: 0 }));
    const tasksBy = new Map<string, { todo: number; doing: number; done: number }>();
    for (const t of taskRows) {
      const c = tasksBy.get(t.project_id) ?? { todo: 0, doing: 0, done: 0 };
      if (t.status === 'todo') c.todo += t.n;
      else if (t.status === 'doing') c.doing += t.n;
      else if (t.status === 'done') c.done += t.n;
      tasksBy.set(t.project_id, c);
    }
    const lim = (w: (typeof limits)['fiveHour']): LimitFact | null => (w ? { usedPct: w.usedPct, source: w.source, resetsAt: w.resetsAt } : null);
    const mins = (d: Date | null): number | null => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000)) : null);
    return {
      now,
      machines: machines.map((m) => ({ id: m.id, name: m.name, online: m.online, openSessions: m.open, working: m.working, waiting: m.waiting, awaitingApproval: m.awaiting, lastSeenMinutesAgo: mins(m.last_seen_at) })),
      sessions: sessions.map((s) => ({ id: s.id, project: s.project, machine: s.machine, status: s.status, task: s.task, sinceMinutes: s.since })),
      projects: projects.items.map((p) => ({ id: p.id, name: p.name, machine: p.machineSlug, todayTokens: p.today.totalTokens, openSessions: p.openSessions, tasks: tasksBy.get(p.id) ?? { todo: 0, doing: 0, done: 0 } })),
      usage: {
        todayTokens: usage.today.totals.totalTokens,
        last7dTokens: usage.last7d.totals.totalTokens,
        last30dTokens: usage.last30d.totals.totalTokens,
        todayCostUsd: usage.today.totals.costUsd,
        last7dCostUsd: usage.last7d.totals.costUsd,
      },
      limits: { fiveHour: lim(limits.fiveHour), sevenDay: lim(limits.sevenDay) },
      queue: queue.map((x) => ({ status: x.status, count: x.n })),
      reports: reports.map((r) => ({ id: r.id, kind: r.kind, periodStart: r.period_start, text: stripHtml(r.text_html) })),
      summaries: hits.map((h) => ({ sessionId: h.sessionId, project: h.projectName, machine: h.machineName, taskKey: h.taskKey, createdAt: h.createdAt, summary: h.summary, done: h.done, openItems: h.openItems })),
      decisions: decisions.map((d) => ({ id: d.id, projectId: d.project_id, project: d.project, title: d.title, decision: d.decision, createdAt: d.created_at.toISOString() })),
    };
  }
}

/** Telegram uchun: tayyor xato matni (HTML-siz). */
export function askErrorText(err: unknown): string {
  if (err instanceof HttpException) {
    const r = err.getResponse();
    const msg = typeof r === 'object' && r !== null && 'message' in r ? String((r as { message: unknown }).message) : err.message;
    return msg.slice(0, 300);
  }
  if (err instanceof ConflictException) return 'Yordamchi mavjud emas';
  return "So'rov bajarilmadi";
}
