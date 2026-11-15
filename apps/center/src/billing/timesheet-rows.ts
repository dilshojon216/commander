import type { TimesheetDto } from '@commander/contracts';
import { billedMinutes } from './money.js';

/** Eksport uchun tekis jadval (CSV/XLSX/PDF bir xil ustunlar). Uzbek sarlavhalar. */

export const TIMESHEET_HEADERS = [
  'Mijoz',
  'Loyiha',
  'Vazifa',
  'Nomi',
  'Faol vaqt (s:daq)',
  'Faol soat',
  'Sessiyalar',
  'Yopilgan vazifalar',
  'Commitlar',
  'Input token',
  'Output token',
  'Cache read',
  'Cache creation',
  'API-ekvivalent narx (USD)',
  'Reja (soat)',
  'Summa',
  'Valyuta',
] as const;

export type Cell = string | number | null;
export interface TimesheetRow {
  /** `client` | `project` | `task` | `total`: uslub uchun. */
  kind: 'client' | 'project' | 'task' | 'total';
  cells: Cell[];
}

/** Soniya -> "S:DD" (eng yaqin daqiqaga yaxlitlanadi: summa bilan bir xil birlik). */
export function formatHm(seconds: number): string {
  const m = billedMinutes(seconds);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export const hoursDecimal = (seconds: number): number => Math.round((billedMinutes(seconds) / 60) * 100) / 100;

const R6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e4) / 1e4);

export function timesheetRows(dto: TimesheetDto): TimesheetRow[] {
  const rows: TimesheetRow[] = [];
  for (const c of dto.clients) {
    rows.push({
      kind: 'client',
      cells: [
        c.name, '', '', '', formatHm(c.totals.activeSeconds), hoursDecimal(c.totals.activeSeconds), c.totals.sessions, c.totals.tasksClosed, c.totals.commits,
        c.totals.tokens.input, c.totals.tokens.output, c.totals.tokens.cacheRead, c.totals.tokens.cacheCreation, R6(c.totals.costUsd), c.totals.plannedSeconds > 0 ? hoursDecimal(c.totals.plannedSeconds) : null,
        c.amount === null ? (c.amountNote ?? '') : Number(c.amount), c.amountCurrency ?? '',
      ],
    });
    for (const p of c.projects) {
      rows.push({
        kind: 'project',
        cells: [
          c.name, p.name, '', '', formatHm(p.totals.activeSeconds), hoursDecimal(p.totals.activeSeconds), p.totals.sessions, p.totals.tasksClosed, p.totals.commits,
          p.totals.tokens.input, p.totals.tokens.output, p.totals.tokens.cacheRead, p.totals.tokens.cacheCreation, R6(p.totals.costUsd), p.totals.plannedSeconds > 0 ? hoursDecimal(p.totals.plannedSeconds) : null, null, '',
        ],
      });
      for (const t of p.tasks) {
        rows.push({
          kind: 'task',
          cells: [
            c.name, p.name, t.key, t.title ?? '', formatHm(t.activeSeconds), hoursDecimal(t.activeSeconds), t.sessions, t.closedInPeriod ? 1 : 0, t.commits,
            t.tokens.input, t.tokens.output, t.tokens.cacheRead, t.tokens.cacheCreation, R6(t.costUsd), t.plannedHours, null, '',
          ],
        });
      }
    }
  }
  const t = dto.total;
  rows.push({
    kind: 'total',
    cells: ['JAMI', '', '', '', formatHm(t.activeSeconds), hoursDecimal(t.activeSeconds), t.sessions, t.tasksClosed, t.commits, t.tokens.input, t.tokens.output, t.tokens.cacheRead, t.tokens.cacheCreation, R6(t.costUsd), t.plannedSeconds > 0 ? hoursDecimal(t.plannedSeconds) : null, null, ''],
  });
  return rows;
}

export function exportFilename(dto: TimesheetDto, ext: 'csv' | 'xlsx' | 'pdf'): string {
  const period = dto.period.from === dto.period.to ? dto.period.from : `${dto.period.from}_${dto.period.to}`;
  return `hisob-kitob_${period}.${ext}`;
}

export const EXPORT_NOTES: readonly string[] = [
  "Faol vaqt = sessiya 'working' yoki 'awaiting_approval' holatida bo'lgan vaqt; bitta oraliq <= 4 soat; parallel sessiyalar ikki marta sanalmaydi.",
  "Summa = faturalangan daqiqalar x soatlik stavka / 60 (yaxlitlash: half-up).",
  "API-ekvivalent narx obuna uchun haqiqiy to'lov emas.",
];
