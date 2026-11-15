import type { ClientReportModel } from '@commander/contracts';
import { addDays, tashkentDayOf } from '../../projects/tashkent-day.js';
import { sanitizeClientText, sanitizeLines } from './sanitize.js';
import type { SanitizeContext } from './sanitize.js';

/**
 * Mijoz hisoboti modeli (6.8): sof funksiya. Kirish xom DB qatorlari, chiqish OQ RO'YXATDAGI maydonlardan iborat
 * `ClientReportModel` (faqat tozalangan sarlavhalar, sonlar, sanalar). Render (HTML/PDF) FAQAT shu modelni ko'radi:
 * xom qatorlar (yo'l, xesh, mashina) renderga hech qachon yetmaydi.
 */

export const CLIENT_REPORT_LIMITS = { titleChars: 160, nameChars: 80, summaryLineChars: 300, maxTasksPerList: 150, maxLinesPerDay: 6, maxLinesPerWeek: 10, maxWeeks: 60, maxGroups: 30 } as const;
export const FALLBACK_TASK_TITLE = 'Vazifa';

export interface ReportTaskRow {
  taskKey: string;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'unknown';
  order: number;
}
export interface ReportGroupInput {
  projectKey: string;
  name: string;
  tasks: readonly ReportTaskRow[];
  /** Davr ichida yopilgan: vazifa kaliti -> yopilgan vaqt (ms). */
  closed: ReadonlyMap<string, number>;
}
export interface ReportSummaryRow {
  day: string;
  text: string;
}
export interface ClientReportInput {
  title: string;
  from: string;
  to: string;
  now: Date;
  groups: readonly ReportGroupInput[];
  summaries: readonly ReportSummaryRow[];
  showSummary: boolean;
  /** `null` = soatlar ko'rsatilmaydi. */
  activeSeconds: number | null;
  ctx: SanitizeContext;
}

/** Berilgan kunning haftasi boshi (dushanba, `YYYY-MM-DD`). */
export function weekStartOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = yakshanba
  return addDays(day, -((dow + 6) % 7));
}

export function buildClientReportModel(input: ClientReportInput): ClientReportModel {
  const L = CLIENT_REPORT_LIMITS;
  let truncated = false;
  const cap = <T>(list: T[]): T[] => {
    if (list.length > L.maxTasksPerList) {
      truncated = true;
      return list.slice(0, L.maxTasksPerList);
    }
    return list;
  };
  const titleOf = (t: ReportTaskRow): { title: string } => ({ title: sanitizeClientText(t.title, input.ctx, L.titleChars) || FALLBACK_TASK_TITLE });

  let done = 0;
  let doing = 0;
  let todo = 0;
  const groups: ClientReportModel['groups'] = [];
  const weekly = new Map<string, number>();
  const rangeStart = weekStartOf(input.from);
  for (let w = rangeStart, i = 0; w <= input.to && i < L.maxWeeks; w = addDays(w, 7), i++) weekly.set(w, 0);

  input.groups.slice(0, L.maxGroups).forEach((g, idx) => {
    const sorted = [...g.tasks].sort((a, b) => a.order - b.order);
    const d = sorted.filter((t) => t.status === 'done');
    const p = sorted.filter((t) => t.status === 'doing');
    const r = sorted.filter((t) => t.status === 'todo');
    done += d.length;
    doing += p.length;
    todo += r.length;
    const closedRows = sorted.filter((t) => g.closed.has(t.taskKey));
    for (const [, ts] of g.closed) {
      const wk = weekStartOf(tashkentDayOf(new Date(ts)));
      if (weekly.has(wk)) weekly.set(wk, (weekly.get(wk) ?? 0) + 1);
    }
    groups.push({
      name: sanitizeClientText(g.name, input.ctx, L.nameChars) || `Loyiha ${idx + 1}`,
      done: cap(d.map(titleOf)),
      inProgress: cap(p.map(titleOf)),
      remaining: cap(r.map(titleOf)),
      closedInPeriod: cap(closedRows.map(titleOf)),
    });
  });

  const summaries: ClientReportModel['summaries'] = [];
  if (input.showSummary) {
    const byWeek = new Map<string, string[]>();
    for (const s of [...input.summaries].sort((a, b) => a.day.localeCompare(b.day))) {
      const lines = sanitizeLines(s.text, input.ctx, { maxLines: L.maxLinesPerDay, maxChars: L.summaryLineChars });
      const wk = weekStartOf(s.day);
      const cur = byWeek.get(wk) ?? [];
      for (const line of lines) if (!cur.includes(line) && cur.length < L.maxLinesPerWeek) cur.push(line);
      byWeek.set(wk, cur);
    }
    for (const [weekStart, lines] of [...byWeek].sort((a, b) => a[0].localeCompare(b[0]))) if (lines.length > 0) summaries.push({ weekStart, lines });
  }

  const total = done + doing + todo;
  return {
    title: sanitizeClientText(input.title, input.ctx, L.nameChars) || 'Hisobot',
    periodFrom: input.from,
    periodTo: input.to,
    generatedDay: tashkentDayOf(input.now),
    progress: { done, inProgress: doing, remaining: todo, total, percentDone: total === 0 ? 0 : Math.round((done / total) * 100) },
    groups,
    weekly: [...weekly].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, closed]) => ({ weekStart, closed })),
    summaries,
    activeSeconds: input.activeSeconds === null ? null : Math.max(0, Math.round(input.activeSeconds)),
    truncated,
  };
}
