import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { TimesheetDto } from '@commander/contracts';
import { pdfSafe } from './pdf-text.js';
import { timesheetPdf } from './timesheet-pdf.js';
import { TIMESHEET_HEADERS, exportFilename, formatHm, timesheetRows } from './timesheet-rows.js';
import { toCsv } from './csv.js';
import { timesheetXlsx } from './xlsx.js';

const totals = (s: number) => ({ activeSeconds: s, sessions: 2, tasksClosed: 1, commits: 3, tokens: { input: 1000, output: 500, cacheRead: 10, cacheCreation: 5 }, costUsd: 1.25, plannedSeconds: 7200, plannedActualSeconds: s });
const dto: TimesheetDto = {
  period: { from: '2026-11-01', to: '2026-11-30' },
  generatedAt: '2026-12-01T00:00:00.000Z',
  currency: null,
  fxUzsPerUsd: null,
  activeCapHours: 4,
  taskTokensPartial: true,
  activeTimePartial: false,
  clients: [
    {
      clientId: '11111111-1111-4111-8111-111111111111',
      name: '=HYPERLINK("http://evil","x")',
      hourlyRate: '10',
      rateCurrency: 'USD',
      amount: '15.00',
      amountCurrency: 'USD',
      billedMinutes: 90,
      amountNote: null,
      totals: totals(5400),
      overlapSeconds: 0,
      projects: [
        {
          projectKey: 'github.com/o/a',
          name: '@alpha, "q"',
          totals: totals(5400),
          unattributedSeconds: 0,
          tasks: [{ key: '6.7', title: '+cmd|calc', status: 'doing', activeSeconds: 5400, sessions: 1, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }, costUsd: 0.5, commits: 2, closedInPeriod: true, plannedHours: 2 }],
        },
      ],
    },
  ],
  total: totals(5400),
};

describe('CSV eksport', () => {
  it("formula-in'ektsiya katakchalari neytrallashgan, ustunlar soni bir xil", () => {
    const rows = timesheetRows(dto);
    expect(rows.every((r) => r.cells.length === TIMESHEET_HEADERS.length)).toBe(true);
    const csv = toCsv(TIMESHEET_HEADERS, rows.map((r) => r.cells));
    const lines = csv.split('\r\n');
    expect(lines[0]!.startsWith('﻿Mijoz,Loyiha')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`"'@alpha, ""q"""`);
    expect(csv).toContain("'+cmd|calc");
    for (const line of lines.slice(1)) expect(line).not.toMatch(/(^|,)[=+@]/); // hech bir katak formula bilan boshlanmaydi
  });
  it('soat ko\'rinishi', () => {
    expect(formatHm(5400)).toBe('1:30');
    expect(formatHm(59)).toBe('0:01');
    expect(formatHm(0)).toBe('0:00');
  });
  it('fayl nomi', () => {
    expect(exportFilename(dto, 'xlsx')).toBe('hisob-kitob_2026-11-01_2026-11-30.xlsx');
    expect(exportFilename({ ...dto, period: { from: '2026-11-05', to: '2026-11-05' } }, 'csv')).toBe('hisob-kitob_2026-11-05.csv');
  });
});

describe('XLSX eksport', () => {
  it("fayl ochiladi, varaqlar bor, formula YO'Q (matn katak)", async () => {
    const buf = await timesheetXlsx(dto);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Xulosa', 'Batafsil']);
    const det = wb.getWorksheet('Batafsil')!;
    expect(det.getRow(1).getCell(1).value).toBe('Mijoz');
    expect(det.rowCount).toBe(1 + timesheetRows(dto).length);
    let formulas = 0;
    det.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'object' && c.value !== null && 'formula' in c.value) formulas++; }));
    wb.getWorksheet('Xulosa')!.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'object' && c.value !== null && 'formula' in c.value) formulas++; }));
    expect(formulas).toBe(0);
    expect(det.getRow(2).getCell(1).value).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(det.getRow(2).getCell(6).value).toBe(1.5);
    const sum = wb.getWorksheet('Xulosa')!;
    expect(sum.getRow(4).getCell(6).value).toBe(15);
  });
});

describe('PDF eksport', () => {
  it("to'g'ri PDF sarlavhasi va yakuni; kirill/Unicode matn qulamaydi", async () => {
    const buf = await timesheetPdf({ ...dto, clients: [{ ...dto.clients[0]!, name: 'Мижоз Ўзбекистон ‘test’ 😀' }] });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.subarray(-6).toString()).toContain('%%EOF');
    expect(buf.length).toBeGreaterThan(1500);
  });
  it('ko\'p qatorli jadval sahifalanadi', async () => {
    const tasks = Array.from({ length: 40 }, (_, i) => ({ ...dto.clients[0]!.projects[0]!.tasks[0]!, key: `t${i}` }));
    const big: TimesheetDto = { ...dto, clients: Array.from({ length: 8 }, (_, i) => ({ ...dto.clients[0]!, name: `C${i}`, projects: [{ ...dto.clients[0]!.projects[0]!, tasks }] })) };
    const buf = await timesheetPdf(big);
    expect(buf.toString('latin1').match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(2);
  });
});

describe('pdfSafe', () => {
  it.each([
    ['Ўзбекистон', "O'zbekiston"],
    ['Қўқон ғиштин', "Qo'qon g'ishtin"],
    ['o‘zbek gʻoya', "o'zbek g'oya"],
    ['Hello 😀', 'Hello ?'],
    ['a\u0000b\nc', 'ab c'],
    ['naïve café', 'naïve café'],
  ])('%j -> %j', (input, expected) => expect(pdfSafe(input)).toBe(expected));
});
