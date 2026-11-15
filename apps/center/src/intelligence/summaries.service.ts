import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SessionSummaryPayloadSchema, SummarySearchResponseSchema } from '@commander/contracts';
import type { PutSummarySettingsBody, SessionSummaryDto, SessionSummaryPayload, SummaryCheckResult, SummarySearchHit, SummarySearchQuery, SummarySettingsResponse, SummarySettings, SummaryStoredResult } from '@commander/contracts';
import { redactAndCap } from '../common/redact-text.js';
import { AuditService } from '../identity/audit/audit.service.js';
import type { AuditActorKind } from '../identity/audit/audit.service.js';
import { MessagingError } from '../messaging/messaging.service.js';
import { askKeywords, buildSearchText, buildTsQuery, evaluateCheck, likePattern, normTitle, normalizeSettings, tashkentDay } from './summary-logic.js';

const SETTINGS_KEY = 'summaries.config';

interface SessionRow {
  id: string;
  machine_id: string;
  project_id: string | null;
  base_key: string | null;
}

interface SummaryRow {
  id: string;
  session_id: string;
  project_id: string | null;
  project_name: string | null;
  machine_id: string;
  machine_name: string;
  task_key: string | null;
  summary: string;
  done: string[];
  files: string[];
  open_items: string[];
  model: string;
  tokens_used: number;
  prompt_count: number;
  source_tokens: string | number;
  trigger: 'ended' | 'idle';
  created_at: Date;
  updated_at: Date;
  headline?: string;
  rank?: number;
}

const SELECT = `
  SELECT ss.id, ss.session_id, ss.project_id, p.name AS project_name, ss.machine_id,
         COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, ss.task_key, ss.summary, ss.done, ss.files, ss.open_items,
         ss.model, ss.tokens_used, ss.prompt_count, ss.source_tokens, ss.trigger, ss.created_at, ss.updated_at
    FROM session_summaries ss
    JOIN machines m ON m.id = ss.machine_id
    LEFT JOIN projects p ON p.id = ss.project_id`;

export function toSummaryDto(r: SummaryRow): SessionSummaryDto {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    projectName: r.project_name,
    machineId: r.machine_id,
    machineName: r.machine_name,
    taskKey: r.task_key,
    summary: r.summary,
    done: r.done,
    files: r.files,
    openItems: r.open_items,
    model: r.model,
    tokensUsed: r.tokens_used,
    promptCount: r.prompt_count,
    sourceTokens: Number(r.source_tokens),
    trigger: r.trigger,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/**
 * Sessiya xulosalari (6.1): agentd yuborgan xulosani saqlaydi, to'liq matnli qidiruv (tsvector `simple` + prefiks, `ILIKE`/trigram),
 * sozlamalar (global/mashina/loyiha, minimal prompt/token, kunlik chegara). Transcript markazga kelmaydi; kelgan matn markazda
 * yana redakt qilinadi (xavfsizlik to'ri).
 */
@Injectable()
export class SummariesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async settings(): Promise<SummarySettings> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
    return normalizeSettings(rows[0]?.value);
  }

  async usedToday(now: Date = new Date()): Promise<number> {
    const rows: Array<{ runs: number }> = await this.dataSource.query(`SELECT runs FROM summary_runs WHERE day = $1::date`, [tashkentDay(now)]);
    return rows[0]?.runs ?? 0;
  }

  async settingsView(now: Date = new Date()): Promise<SummarySettingsResponse> {
    return { ...(await this.settings()), usedToday: await this.usedToday(now) };
  }

  async putSettings(body: PutSummarySettingsBody, actor: { deviceId: string | null; actorKind: AuditActorKind; ip: string | null }): Promise<SummarySettingsResponse> {
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [SETTINGS_KEY, JSON.stringify(body)],
      );
      await this.audit.record(
        { actorDeviceId: actor.deviceId, actorKind: actor.actorKind, action: 'summary.settings', target: SETTINGS_KEY, ip: actor.ip, details: { enabled: body.enabled, machines: body.disabledMachineIds.length, projects: body.disabledProjectIds.length, minPrompts: body.minPrompts, minTokens: body.minTokens, dailyCap: body.dailyCap } },
        m,
      );
    });
    return this.settingsView();
  }

  private async sessionRow(machineId: string, claudeSessionId: string): Promise<SessionRow | null> {
    const rows: SessionRow[] = await this.dataSource.query(
      `SELECT s.id, s.machine_id, s.project_id, COALESCE(NULLIF(p.repo_key, ''), 'project:' || p.id::text) AS base_key
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.machine_id = $1 AND s.claude_session_id = $2`,
      [machineId, claudeSessionId],
    );
    return rows[0] ?? null;
  }

  /** Mailbox op `summary_check`. */
  async check(machineId: string, claudeSessionId: string, now: Date = new Date()): Promise<SummaryCheckResult> {
    const [settings, row, used] = await Promise.all([this.settings(), this.sessionRow(machineId, claudeSessionId), this.usedToday(now)]);
    return evaluateCheck({ settings, known: row !== null, machineId: row?.machine_id ?? null, projectId: row?.project_id ?? null, usedToday: used });
  }

  /** Mailbox op `session_summary`: qayta tekshirish (sozlama o'zgargan bo'lishi mumkin), redakt, upsert, kunlik hisob, takliflar. */
  async ingest(machineId: string, deviceId: string, claudeSessionId: string, raw: SessionSummaryPayload, now: Date = new Date()): Promise<SummaryStoredResult> {
    const parsed = SessionSummaryPayloadSchema.safeParse(raw);
    if (!parsed.success) throw new MessagingError('invalid_request', 'Xulosa yaroqsiz');
    const p = parsed.data;
    const row = await this.sessionRow(machineId, claudeSessionId);
    if (!row) throw new MessagingError('session_unknown', "Center bu sessiyani bilmaydi");
    const settings = await this.settings();
    if (!settings.enabled || settings.disabledMachineIds.includes(machineId) || (row.project_id && settings.disabledProjectIds.includes(row.project_id))) return { stored: false, proposals: 0 };

    // Xavfsizlik to'ri: agentd redakt qilgan, markaz yana qiladi (kesish redaktdan KEYIN).
    const list = (xs: readonly string[], n: number, c: number): string[] => xs.slice(0, n).map((x) => redactAndCap(x, c)).filter((x) => x.trim() !== '');
    const summary = redactAndCap(p.summary, 1500);
    const done = list(p.done, 12, 220);
    const files = list(p.files, 30, 200);
    const openItems = list(p.openItems, 12, 220);
    const task: Array<{ task_key: string }> = await this.dataSource.query(
      `SELECT task_key FROM session_task_spans WHERE machine_id = $1 AND session_id = $2 ORDER BY started_at DESC LIMIT 1`,
      [machineId, claudeSessionId],
    );
    const searchText = buildSearchText({ summary, done, files, openItems });
    let proposals = 0;
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `INSERT INTO session_summaries (session_id, machine_id, project_id, task_key, summary, done, files, open_items, model, tokens_used, prompt_count, source_tokens, trigger, search_text, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, now(), now())
         ON CONFLICT (session_id) DO UPDATE SET
           project_id = EXCLUDED.project_id, task_key = EXCLUDED.task_key, summary = EXCLUDED.summary, done = EXCLUDED.done, files = EXCLUDED.files,
           open_items = EXCLUDED.open_items, model = EXCLUDED.model, tokens_used = session_summaries.tokens_used + EXCLUDED.tokens_used,
           prompt_count = EXCLUDED.prompt_count, source_tokens = EXCLUDED.source_tokens, trigger = EXCLUDED.trigger, search_text = EXCLUDED.search_text, updated_at = now()`,
        [row.id, machineId, row.project_id, task[0]?.task_key ?? null, summary, JSON.stringify(done), JSON.stringify(files), JSON.stringify(openItems), p.model, p.tokensUsed, p.promptCount, p.sourceTokens, p.trigger, searchText],
      );
      await m.query(
        `INSERT INTO summary_runs (day, runs, tokens) VALUES ($1::date, 1, $2)
         ON CONFLICT (day) DO UPDATE SET runs = summary_runs.runs + 1, tokens = summary_runs.tokens + EXCLUDED.tokens`,
        [tashkentDay(now), p.tokensUsed],
      );
      if (row.base_key) {
        for (const d of p.decisions) {
          const title = redactAndCap(d.title, 120);
          const existing: Array<{ title: string }> = await m.query(`SELECT title FROM project_decisions WHERE base_key = $1 AND status IN ('proposed', 'active')`, [row.base_key]);
          if (existing.some((e) => normTitle(e.title) === normTitle(title))) continue;
          await m.query(
            `INSERT INTO project_decisions (base_key, project_id, title, decision, reason, status, source, source_session_id) VALUES ($1, $2, $3, $4, $5, 'proposed', 'summary', $6)`,
            [row.base_key, row.project_id, title, redactAndCap(d.decision, 1000), redactAndCap(d.reason, 1000), row.id],
          );
          proposals += 1;
        }
      }
      await this.audit.record(
        // Matn YOZILMAYDI: faqat o'lchamlar
        { actorDeviceId: deviceId, actorKind: 'agentd', action: 'summary.stored', target: row.id, details: { trigger: p.trigger, summaryChars: summary.length, done: done.length, files: files.length, tokensUsed: p.tokensUsed, proposals } },
        m,
      );
    });
    return { stored: true, proposals };
  }

  /** Eng so'nggi xulosalar (savol kontekstida qidiruv hech narsa topmasa). */
  async recent(limit: number): Promise<SessionSummaryDto[]> {
    const rows: SummaryRow[] = await this.dataSource.query(`${SELECT} ORDER BY ss.updated_at DESC LIMIT $1`, [limit]);
    return rows.map(toSummaryDto);
  }

  async forSession(sessionId: string): Promise<SessionSummaryDto | null> {
    const rows: SummaryRow[] = await this.dataSource.query(`${SELECT} WHERE ss.session_id = $1`, [sessionId]);
    return rows[0] ? toSummaryDto(rows[0]) : null;
  }

  /** Qidiruv: tsvector (prefiks, `simple`) YOKI `ILIKE` (trigram indeksi bo'lsa tezlashadi). Tartib: moslik, so'ng yangilik. */
  async search(q: SummarySearchQuery, opts: { any?: boolean } = {}): Promise<SummarySearchHit[]> {
    // `any` (savol kontekstida): so'zlar OR bilan, `ILIKE` yo'q (butun savol matni mos kelmaydi)
    const ts = opts.any ? buildTsQuery(askKeywords(q.q), '|') : buildTsQuery(q.q);
    const like = opts.any ? null : likePattern(q.q);
    const rows: SummaryRow[] = await this.dataSource.query(
      `WITH qq AS (SELECT CASE WHEN $1::text IS NULL THEN NULL ELSE to_tsquery('simple', $1::text) END AS tsq)
       SELECT x.*,
              ts_headline('simple', x.summary, COALESCE((SELECT tsq FROM qq), plainto_tsquery('simple', '')), 'StartSel=«, StopSel=», MaxFragments=2, MaxWords=28, MinWords=8') AS headline,
              (COALESCE(ts_rank(x.search, (SELECT tsq FROM qq)), 0) + CASE WHEN $2::text IS NOT NULL AND x.search_text ILIKE $2 THEN 0.1 ELSE 0 END)::float8 AS rank
         FROM (
           SELECT ss.id, ss.session_id, ss.project_id, p.name AS project_name, ss.machine_id,
                  COALESCE(m.display_name, m.hostname, m.slug) AS machine_name, ss.task_key, ss.summary, ss.done, ss.files, ss.open_items,
                  ss.model, ss.tokens_used, ss.prompt_count, ss.source_tokens, ss.trigger, ss.created_at, ss.updated_at, ss.search, ss.search_text
             FROM session_summaries ss
             JOIN machines m ON m.id = ss.machine_id
             LEFT JOIN projects p ON p.id = ss.project_id
            WHERE ((SELECT tsq FROM qq) IS NOT NULL AND ss.search @@ (SELECT tsq FROM qq) OR ($2::text IS NOT NULL AND ss.search_text ILIKE $2))
              AND ($3::uuid IS NULL OR ss.project_id = $3::uuid)
              AND ($4::uuid IS NULL OR ss.machine_id = $4::uuid)
         ) x
        ORDER BY rank DESC, x.updated_at DESC
        LIMIT $5`,
      [ts, like, q.project ?? null, q.machine ?? null, q.limit],
    );
    const items = rows.map((r) => ({ ...toSummaryDto(r), headline: r.headline ?? r.summary.slice(0, 160), rank: r.rank ?? 0 }));
    return SummarySearchResponseSchema.parse({ items }).items;
  }
}

export type { SummaryRow };
