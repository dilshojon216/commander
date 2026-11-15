import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BILLING_LIMITS } from '@commander/contracts';
import type { ClientReportModel, ClientReportPreview, ClientReportQuery, ClientReportSnapshotDto, CreateClientReportBody, CreateClientReportResponse, ExportFile, ListClientReportSnapshotsResponse } from '@commander/contracts';
import type { Principal } from '../../identity/common/request-context.js';
import { isValidDay, tashkentDayRange } from '../../projects/tashkent-day.js';
import { TelegramService } from '../../telegram/telegram.service.js';
import { TimesheetService } from '../timesheet.service.js';
import { periodDays } from '../timesheet-logic.js';
import { renderClientReportHtml } from './html.js';
import { findLeaks } from './leak-check.js';
import { buildClientReportModel } from './model.js';
import type { ReportGroupInput, ReportSummaryRow, ReportTaskRow } from './model.js';
import { renderClientReportPdf } from './pdf.js';

type Row = Record<string, unknown>;
const KEY = (a: string): string => `COALESCE(${a}.repo_key, ${a}.id::text)`;
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

interface Scope {
  clientId: string | null;
  clientName: string;
  projectKeys: string[];
}

export interface Composed {
  model: ClientReportModel;
  html: string;
  scope: Scope;
}

const toFile = (filename: string, contentType: string, data: Buffer): ExportFile => ({ filename, contentType, sizeBytes: data.length, dataBase64: data.toString('base64') });

/**
 * 6.8: mijoz uchun "faqat ko'rish" statik hisobot. Markaz ommaga ochilmaydi (Tailscale), shuning uchun hisobot — yuklab olinadigan
 * o'z-o'zini qamragan HTML + PDF; egasi uni o'zi mijozga yuboradi. Har generatsiya `client_report_snapshots` ga yoziladi
 * (kim/qachon/ko'lam/xesh). Maxfiylik: model faqat tozalangan maydonlar, oxirida `findLeaks` (topilsa 422).
 */
@Injectable()
export class ClientReportService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly timesheet: TimesheetService,
    @Optional() private readonly telegram?: TelegramService,
  ) {}

  async preview(q: ClientReportQuery): Promise<ClientReportPreview> {
    const c = await this.compose({ clientId: q.clientId, projectKey: q.projectKey, from: q.from, to: q.to, showHours: q.showHours === '1', showSummary: q.showSummary !== '0' });
    return { model: c.model, html: c.html };
  }

  async create(body: CreateClientReportBody, principal: Principal): Promise<CreateClientReportResponse> {
    const c = await this.compose(body);
    const htmlBuf = Buffer.from(c.html, 'utf8');
    const pdfBuf = await renderClientReportPdf(c.model);
    const rows: Row[] = await this.dataSource.query(
      `INSERT INTO client_report_snapshots (actor_device_id, actor_kind, client_id, client_name, project_keys, period_from, period_to, show_hours, show_summary, html_sha256, pdf_sha256, html_bytes, pdf_bytes)
       VALUES ($1, $2, $3, $4, $5::text[], $6::date, $7::date, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [principal.device.id, principal.actorKind, c.scope.clientId, c.scope.clientName, c.scope.projectKeys, body.from, body.to, body.showHours, body.showSummary, sha256(htmlBuf), sha256(pdfBuf), htmlBuf.length, pdfBuf.length],
    );
    const id = rows[0]!['id'] as string;
    const base = `hisobot_${c.model.generatedDay}_${body.from}_${body.to}`;
    const htmlName = `${base}.html`;
    const pdfName = `${base}.pdf`;

    let delivered: number | null = null;
    if (body.sendToOwnerTelegram) {
      delivered = this.telegram ? await this.telegram.notifyDocuments([{ filename: htmlName, data: htmlBuf }, { filename: pdfName, data: pdfBuf }], `Mijoz hisoboti: ${c.model.title} (${body.from} – ${body.to}). Faqat sizga yuborildi; mijozga o'zingiz yuboring.`) : 0;
      if (delivered > 0) await this.dataSource.query(`UPDATE client_report_snapshots SET telegram_sent_at = now() WHERE id = $1`, [id]);
    }
    const snap = (await this.list(1, id)).items[0]!;
    return { snapshot: snap, html: toFile(htmlName, 'text/html; charset=utf-8', htmlBuf), pdf: toFile(pdfName, 'application/pdf', pdfBuf), telegramDelivered: delivered };
  }

  async list(limit = 50, id?: string): Promise<ListClientReportSnapshotsResponse> {
    const rows: Row[] = await this.dataSource.query(
      `SELECT id, created_at, actor_kind, actor_device_id, client_name, project_keys, to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to,
              show_hours, show_summary, html_sha256, pdf_sha256, html_bytes, pdf_bytes, telegram_sent_at
         FROM client_report_snapshots WHERE ($2::uuid IS NULL OR id = $2::uuid) ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200), id ?? null],
    );
    const items: ClientReportSnapshotDto[] = rows.map((r) => ({
      id: r['id'] as string,
      createdAt: (r['created_at'] as Date).toISOString(),
      actorKind: r['actor_kind'] as string,
      actorDeviceId: (r['actor_device_id'] as string | null) ?? null,
      clientName: r['client_name'] as string,
      projectKeys: r['project_keys'] as string[],
      periodFrom: r['period_from'] as string,
      periodTo: r['period_to'] as string,
      showHours: r['show_hours'] as boolean,
      showSummary: r['show_summary'] as boolean,
      htmlSha256: r['html_sha256'] as string,
      pdfSha256: r['pdf_sha256'] as string,
      htmlBytes: Number(r['html_bytes']),
      pdfBytes: Number(r['pdf_bytes']),
      telegramSentAt: r['telegram_sent_at'] ? (r['telegram_sent_at'] as Date).toISOString() : null,
    }));
    return { items };
  }

  private async scope(q: { clientId?: string; projectKey?: string }): Promise<Scope> {
    if (q.clientId) {
      const c: Row[] = await this.dataSource.query(`SELECT name FROM clients WHERE id = $1`, [q.clientId]);
      if (!c[0]) throw new NotFoundException({ error: 'client_not_found', message: 'Mijoz topilmadi' });
      const keys: Row[] = await this.dataSource.query(`SELECT project_key FROM client_projects WHERE client_id = $1 ORDER BY project_key`, [q.clientId]);
      if (keys.length === 0) throw new BadRequestException({ error: 'no_projects', message: "Mijozga loyiha biriktirilmagan" });
      return { clientId: q.clientId, clientName: c[0]['name'] as string, projectKeys: keys.map((k) => k['project_key'] as string) };
    }
    const key = q.projectKey!;
    const p: Row[] = await this.dataSource.query(`SELECT (array_agg(name ORDER BY created_at DESC))[1] AS name FROM projects WHERE ${KEY('projects')} = $1`, [key]);
    if (!p[0] || p[0]['name'] === null) throw new NotFoundException({ error: 'project_not_found', message: 'Loyiha topilmadi' });
    return { clientId: null, clientName: p[0]['name'] as string, projectKeys: [key] };
  }

  /** Model + HTML (yon ta'sirsiz). Sizib chiqish topilsa 422 (`snapshot_leak_detected`). */
  async compose(q: { clientId?: string; projectKey?: string; from: string; to: string; showHours: boolean; showSummary: boolean }): Promise<Composed> {
    if (!isValidDay(q.from) || !isValidDay(q.to) || q.to < q.from) throw new BadRequestException({ error: 'invalid_period', message: "Davr noto'g'ri" });
    if (periodDays(q.from, q.to) > BILLING_LIMITS.maxPeriodDays) throw new BadRequestException({ error: 'period_too_long', message: `Davr ${BILLING_LIMITS.maxPeriodDays} kundan oshmasin` });
    const scope = await this.scope(q);
    const start = tashkentDayRange(q.from).start;
    const end = tashkentDayRange(q.to).end;
    const keys = scope.projectKeys;
    const query = (sql: string, params: unknown[]): Promise<Row[]> => this.dataSource.query(sql, params) as Promise<Row[]>;

    const [projects, machines, tasks, closed, summaries, shas] = await Promise.all([
      query(`SELECT p.name, p.path, ${KEY('p')} AS pk FROM projects p WHERE ${KEY('p')} = ANY($1::text[]) ORDER BY p.created_at DESC`, [keys]),
      query(`SELECT slug, display_name, hostname, tailnet_name, legacy_host FROM machines`, []),
      query(
        `SELECT DISTINCT ON (${KEY('p')}, t.task_key) ${KEY('p')} AS pk, t.task_key, t.title, t.status, t."order"
           FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE ${KEY('p')} = ANY($1::text[])
          ORDER BY ${KEY('p')}, t.task_key, t.updated_at DESC`,
        [keys],
      ),
      query(
        `SELECT ${KEY('p')} AS pk, e.task_key, max(e.ts) AS ts FROM task_events e JOIN projects p ON p.id = e.project_id
          WHERE e.to_status = 'done' AND e.ts >= $2::timestamptz AND e.ts < $3::timestamptz AND ${KEY('p')} = ANY($1::text[]) GROUP BY 1, 2`,
        [keys, start, end],
      ),
      query(
        `SELECT ds.day, ds.summary FROM daily_summaries ds JOIN projects p ON p.id = ds.project_id
          WHERE ds.part = '' AND ds.day BETWEEN $2::date AND $3::date AND ${KEY('p')} = ANY($1::text[]) ORDER BY ds.day`,
        [keys, q.from, q.to],
      ),
      query(
        `SELECT DISTINCT sha FROM (
           SELECT c->>'sha' AS sha FROM project_snapshots ps JOIN projects p ON p.id = ps.project_id CROSS JOIN LATERAL jsonb_array_elements(ps.commits) c WHERE ${KEY('p')} = ANY($1::text[])
           UNION SELECT tc.sha FROM task_commits tc JOIN projects p ON p.id = tc.project_id WHERE ${KEY('p')} = ANY($1::text[])
         ) x WHERE sha IS NOT NULL`,
        [keys],
      ),
    ]);

    const names = new Set<string>();
    for (const m of machines) {
      for (const f of ['slug', 'display_name', 'hostname', 'tailnet_name', 'legacy_host']) {
        const v = m[f];
        if (typeof v === 'string' && v.trim().length >= 3) {
          names.add(v.trim());
          const first = v.trim().split('.')[0]!;
          if (first.length >= 4) names.add(first);
        }
      }
    }
    const paths = new Set<string>();
    for (const p of projects) {
      const path = p['path'] as string;
      if (path.length >= 3) {
        paths.add(path);
        const parent = path.replace(/[/\\][^/\\]*$/, '');
        if (parent.length >= 3) paths.add(parent);
      }
    }
    const sanitizeCtx = { forbidden: [...names, ...paths] };

    const groups: ReportGroupInput[] = keys.map((k) => {
      const name = (projects.find((p) => p['pk'] === k)?.['name'] as string | undefined) ?? k;
      const rows: ReportTaskRow[] = tasks.filter((t) => t['pk'] === k).map((t) => ({ taskKey: t['task_key'] as string, title: t['title'] as string, status: t['status'] as ReportTaskRow['status'], order: Number(t['order']) }));
      const closedMap = new Map<string, number>();
      for (const c of closed) if (c['pk'] === k) closedMap.set(c['task_key'] as string, (c['ts'] as Date).getTime());
      return { projectKey: k, name, tasks: rows, closed: closedMap };
    });
    const summaryRows: ReportSummaryRow[] = summaries.map((s) => ({ day: day(s['day']), text: s['summary'] as string }));

    let activeSeconds: number | null = null;
    if (q.showHours) {
      const dto = await this.timesheet.build({ from: q.from, to: q.to, ...(scope.clientId ? { clientId: scope.clientId } : {}) });
      activeSeconds = scope.clientId ? (dto.clients[0]?.totals.activeSeconds ?? 0) : dto.clients.flatMap((c) => c.projects).find((p) => p.projectKey === scope.projectKeys[0])?.totals.activeSeconds ?? 0;
    }

    const model = buildClientReportModel({ title: scope.clientName, from: q.from, to: q.to, now: new Date(), groups, summaries: summaryRows, showSummary: q.showSummary, activeSeconds, ctx: sanitizeCtx });
    const html = renderClientReportHtml(model);
    const leaks = findLeaks(model, html, { names: [...names], paths: [...paths], shas: shas.map((s) => s['sha'] as string) });
    if (leaks.length > 0) throw new UnprocessableEntityException({ error: 'snapshot_leak_detected', message: 'Hisobotda maxfiy ma\'lumot topildi; yaratish to\'xtatildi', kinds: leaks });
    return { model, html, scope };
  }
}
