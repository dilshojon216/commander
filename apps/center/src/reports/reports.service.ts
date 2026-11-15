import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DEFAULT_REPORT_SETTINGS, ReportDataSchema } from '@commander/contracts';
import type { ListReportsQuery, ListReportsResponse, ReportData, ReportDto, ReportKind, ReportSettings, ReportSummaryDto } from '@commander/contracts';
import { telegramExtensions } from '../telegram/telegram-extensions.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { tashkentDayOf } from '../projects/tashkent-day.js';
import { formatReportHtml } from './report-format.js';
import { duePeriods, normalizeSettings, periodFor } from './report-logic.js';
import type { Period } from './report-logic.js';
import { ReportsDataService } from './reports-data.service.js';

const SETTINGS_KEY = 'reports.settings';
export const REPORTS_TICK_MS = 60_000;

interface ReportRow {
  id: string;
  kind: ReportKind;
  period_start: string;
  period_end: string;
  data: unknown;
  text_html: string;
  generated_at: Date;
  sent_at: Date | null;
}

const COLS = `id, kind, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, data, text_html, generated_at, sent_at`;

function toSummary(r: ReportRow, data: ReportData | null): ReportSummaryDto {
  return {
    id: r.id,
    kind: r.kind,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    generatedAt: r.generated_at.toISOString(),
    sentAt: r.sent_at ? r.sent_at.toISOString() : null,
    tasksClosed: data?.total.tasksClosed.length ?? 0,
    totalTokens: data?.total.tokens.weighted ?? 0,
    costUsd: data?.total.costUsd ?? null,
  };
}

/** Hisobotlar (3.3): jadval bo'yicha yaratish + Telegram + arxiv. `/report` va `/report week` jonli (saqlanmaydi). */
@Injectable()
export class ReportsService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ReportsService.name);
  private timer: NodeJS.Timeout | null = null;
  private unregister: Array<() => void> = [];
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly data: ReportsDataService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  onApplicationBootstrap(): void {
    this.unregister.push(telegramExtensions.register('report', (args) => this.liveReport(args)));
    if (process.env['REPORTS_DISABLED'] === '1') return;
    this.timer = setInterval(() => void this.tick().catch((err: unknown) => this.logger.error(`tick failed: ${err instanceof Error ? err.message : String(err)}`)), REPORTS_TICK_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unregister) u();
    this.unregister = [];
  }

  async getSettings(): Promise<ReportSettings> {
    const rows: Array<{ value: unknown }> = await this.dataSource.query(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
    return rows[0] ? normalizeSettings(rows[0].value) : { ...DEFAULT_REPORT_SETTINGS };
  }

  async putSettings(s: ReportSettings): Promise<ReportSettings> {
    await this.dataSource.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SETTINGS_KEY, JSON.stringify(s)]);
    return s;
  }

  /** Jadval: vaqti kelgan va hali yaratilmagan davrlar (qator bor = yaratilgan, Telegram o'chiq bo'lsa ham qayta yuborilmaydi). */
  async tick(now: Date = new Date()): Promise<Period[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const settings = await this.getSettings();
      const existing: Array<{ kind: string; period_start: string }> = await this.dataSource.query(
        `SELECT kind, to_char(period_start, 'YYYY-MM-DD') AS period_start FROM reports WHERE period_start >= $1::date`,
        [periodFor('weekly', tashkentDayOf(now)).from],
      );
      const due = duePeriods(settings, now, new Set(existing.map((e) => `${e.kind}|${e.period_start}`)));
      for (const p of due) {
        try {
          await this.generate(p.kind, p.to, { send: true, now });
        } catch (err) {
          this.logger.error(`report ${p.kind} ${p.to} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return due;
    } finally {
      this.running = false;
    }
  }

  /** Hisobotni quradi, arxivga yozadi (qayta yaratish yangilaydi), `send` bo'lsa Telegram'ga yuboradi. */
  async generate(kind: ReportKind, day: string, opts: { send: boolean; now?: Date }): Promise<ReportDto> {
    const now = opts.now ?? new Date();
    const period = periodFor(kind, day);
    const report = await this.data.build(period, now);
    const parts = formatReportHtml(report);
    const rows: ReportRow[] = await this.dataSource.query(
      `INSERT INTO reports (kind, period_start, period_end, data, text_html, generated_at)
       VALUES ($1, $2::date, $3::date, $4::jsonb, $5, $6)
       ON CONFLICT (kind, period_start) DO UPDATE SET period_end = EXCLUDED.period_end, data = EXCLUDED.data, text_html = EXCLUDED.text_html, generated_at = EXCLUDED.generated_at
       RETURNING ${COLS}`,
      [kind, period.from, period.to, JSON.stringify(report), parts.join('\n\n').slice(0, 16_000), now],
    );
    let row = rows[0]!;
    if (opts.send && this.telegram) {
      let delivered = 0;
      for (const part of parts) delivered = Math.max(delivered, await this.telegram.notifyText(part));
      if (delivered > 0) {
        const upd: ReportRow[] = await this.dataSource.query(`UPDATE reports SET sent_at = $2 WHERE id = $1 RETURNING ${COLS}`, [row.id, now]);
        row = upd[0] ?? row;
      }
    }
    return { ...toSummary(row, report), data: report, textHtml: row.text_html };
  }

  async list(q: ListReportsQuery): Promise<ListReportsResponse> {
    const rows: ReportRow[] = await this.dataSource.query(`SELECT ${COLS} FROM reports ${q.kind ? 'WHERE kind = $2' : ''} ORDER BY period_start DESC, kind LIMIT $1`, q.kind ? [q.limit, q.kind] : [q.limit]);
    return { items: rows.map((r) => toSummary(r, this.parse(r.data))) };
  }

  async get(id: string): Promise<ReportDto> {
    const rows: ReportRow[] = await this.dataSource.query(`SELECT ${COLS} FROM reports WHERE id = $1`, [id]);
    const r = rows[0];
    const data = r ? this.parse(r.data) : null;
    if (!r || !data) throw new NotFoundException({ error: 'not_found', message: 'Report not found' });
    return { ...toSummary(r, data), data, textHtml: r.text_html };
  }

  private parse(raw: unknown): ReportData | null {
    const p = ReportDataSchema.safeParse(raw);
    return p.success ? p.data : null;
  }

  /** `/report` = bugun (hozirgacha), `/report week` = oxirgi 7 kun. Saqlanmaydi: jadvaldagi yakuniy hisobotni bosib ketmasin. */
  async liveReport(args: string): Promise<string[]> {
    const now = new Date();
    const week = /^(week|hafta|weekly)$/i.test(args.trim());
    const report = await this.data.build(periodFor(week ? 'weekly' : 'daily', tashkentDayOf(now)), now);
    return formatReportHtml(report);
  }
}
