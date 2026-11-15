import ExcelJS from 'exceljs';
import type { TimesheetDto } from '@commander/contracts';
import { neutralizeFormula } from './csv.js';
import { EXPORT_NOTES, TIMESHEET_HEADERS, timesheetRows } from './timesheet-rows.js';
import type { Cell } from './timesheet-rows.js';

const cell = (c: Cell): string | number | null => (typeof c === 'string' ? neutralizeFormula(c) : c);

/** XLSX (exceljs): "Xulosa" (mijozlar) va "Batafsil" (loyiha/vazifa) varaqlari. Formula YO'Q: hamma katak qiymat. */
export async function timesheetXlsx(dto: TimesheetDto): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Commander';
  wb.created = new Date(dto.generatedAt);

  const sum = wb.addWorksheet('Xulosa');
  sum.addRow([`Hisob-kitob: ${dto.period.from} - ${dto.period.to}`]);
  sum.getRow(1).font = { bold: true, size: 13 };
  sum.addRow([]);
  const head = ['Mijoz', 'Faol vaqt (s:daq)', 'Faol soat', 'Faturalangan daqiqa', 'Stavka', 'Summa', 'Valyuta', 'Izoh', 'Sessiyalar', 'Yopilgan vazifalar', 'Commitlar', 'API-ekvivalent narx (USD)'];
  sum.addRow(head);
  sum.getRow(3).font = { bold: true };
  for (const c of dto.clients) {
    const minutes = c.billedMinutes;
    sum.addRow([
      cell(c.name), `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`, Math.round((minutes / 60) * 100) / 100, minutes,
      c.hourlyRate === null ? null : Number(c.hourlyRate), c.amount === null ? null : Number(c.amount), c.amountCurrency ?? '', cell(c.amountNote ?? ''),
      c.totals.sessions, c.totals.tasksClosed, c.totals.commits, c.totals.costUsd,
    ]);
  }
  sum.addRow([]);
  for (const n of EXPORT_NOTES) sum.addRow([n]);
  sum.columns.forEach((col) => (col.width = 22));
  sum.getColumn(1).width = 34;

  const det = wb.addWorksheet('Batafsil');
  det.addRow([...TIMESHEET_HEADERS]);
  det.getRow(1).font = { bold: true };
  det.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of timesheetRows(dto)) {
    const row = det.addRow(r.cells.map(cell));
    if (r.kind === 'client' || r.kind === 'total') row.font = { bold: true };
  }
  det.columns.forEach((col, i) => (col.width = i === 3 ? 46 : i < 3 ? 26 : 16));
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
