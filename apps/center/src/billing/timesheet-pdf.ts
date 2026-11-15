import PDFDocument from 'pdfkit';
import type { TimesheetDto } from '@commander/contracts';
import { pdfSafe } from './pdf-text.js';
import { EXPORT_NOTES, formatHm } from './timesheet-rows.js';

const MARGIN = 36;

interface Col {
  title: string;
  width: number;
  align?: 'left' | 'right';
}

function collect(doc: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Jadval chizadi; sahifa tugasa yangi sahifada sarlavhani takrorlaydi. */
export function drawTable(doc: InstanceType<typeof PDFDocument>, cols: Col[], rows: string[][], opts: { bold?: (i: number) => boolean } = {}): void {
  const rowH = 15;
  const header = (): void => {
    let x = MARGIN;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5);
    for (const c of cols) {
      doc.text(pdfSafe(c.title), x + 2, y, { width: c.width - 4, align: c.align ?? 'left', lineBreak: false });
      x += c.width;
    }
    doc.moveTo(MARGIN, y + rowH - 3).lineTo(x, y + rowH - 3).lineWidth(0.5).stroke('#888888');
    doc.y = y + rowH;
  };
  header();
  rows.forEach((r, i) => {
    if (doc.y + rowH > doc.page.height - MARGIN) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    let x = MARGIN;
    doc.font(opts.bold?.(i) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    r.forEach((v, ci) => {
      const c = cols[ci]!;
      doc.text(pdfSafe(v), x + 2, y, { width: c.width - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true, height: rowH });
      x += c.width;
    });
    doc.y = y + rowH;
  });
  doc.moveDown(0.5);
}

const n = (v: number): string => new Intl.NumberFormat('en-US').format(Math.round(v));
const usd = (v: number | null): string => (v === null ? '-' : v.toFixed(2));

/** Timesheet PDF (pdfkit, Helvetica; matn `pdfSafe` orqali). A4 landscape. */
export async function timesheetPdf(dto: TimesheetDto): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, info: { Title: pdfSafe(`Hisob-kitob ${dto.period.from} - ${dto.period.to}`), Creator: 'Commander' } });
  const done = collect(doc);
  doc.font('Helvetica-Bold').fontSize(16).text(pdfSafe(`Hisob-kitob: ${dto.period.from} - ${dto.period.to}`));
  doc.font('Helvetica').fontSize(8.5).fillColor('#555555').text(pdfSafe(`Yaratilgan: ${dto.generatedAt.slice(0, 16).replace('T', ' ')} UTC`));
  doc.moveDown(0.5).fillColor('#000000');

  doc.font('Helvetica-Bold').fontSize(11).text('Mijozlar');
  doc.moveDown(0.3);
  drawTable(
    doc,
    [
      { title: 'Mijoz', width: 200 },
      { title: 'Faol (s:daq)', width: 70, align: 'right' },
      { title: 'Sessiya', width: 55, align: 'right' },
      { title: 'Yopilgan', width: 55, align: 'right' },
      { title: 'Commit', width: 55, align: 'right' },
      { title: 'Narx USD', width: 70, align: 'right' },
      { title: 'Stavka', width: 70, align: 'right' },
      { title: 'Summa', width: 110, align: 'right' },
    ],
    [
      ...dto.clients.map((c) => [c.name, formatHm(c.totals.activeSeconds), n(c.totals.sessions), n(c.totals.tasksClosed), n(c.totals.commits), usd(c.totals.costUsd), c.hourlyRate === null ? '-' : `${c.hourlyRate} ${c.rateCurrency ?? ''}`, c.amount === null ? (c.amountNote ?? '-') : `${c.amount} ${c.amountCurrency ?? ''}`]),
      ['JAMI', formatHm(dto.total.activeSeconds), n(dto.total.sessions), n(dto.total.tasksClosed), n(dto.total.commits), usd(dto.total.costUsd), '', ''],
    ],
    { bold: (i) => i === dto.clients.length },
  );

  for (const c of dto.clients) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).text(pdfSafe(c.name));
    if (c.overlapSeconds > 0) doc.font('Helvetica').fontSize(8).fillColor('#555555').text(pdfSafe(`Parallel ishlash: loyihalar yig'indisi mijoz jamidan ${formatHm(c.overlapSeconds)} ortiq (jami birlashma).`)).fillColor('#000000');
    doc.moveDown(0.2);
    for (const p of c.projects) {
      if (doc.y > doc.page.height - 100) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9.5).text(pdfSafe(`${p.name}  ·  ${formatHm(p.totals.activeSeconds)}`));
      doc.moveDown(0.2);
      const rows = p.tasks.slice(0, 40).map((t) => [t.key, t.title ?? '', formatHm(t.activeSeconds), t.plannedHours === null ? '-' : `${t.plannedHours}h`, n(t.tokens.input + t.tokens.output), usd(t.costUsd), String(t.commits), t.closedInPeriod ? 'ha' : '']);
      if (rows.length > 0) {
        drawTable(doc, [{ title: 'Vazifa', width: 50 }, { title: 'Nomi', width: 330 }, { title: 'Faol', width: 55, align: 'right' }, { title: 'Reja', width: 45, align: 'right' }, { title: 'Token (in+out)', width: 90, align: 'right' }, { title: 'Narx USD', width: 65, align: 'right' }, { title: 'Commit', width: 50, align: 'right' }, { title: 'Yopildi', width: 50 }], rows);
      }
    }
  }

  doc.moveDown(0.5).font('Helvetica').fontSize(8).fillColor('#555555');
  if (dto.taskTokensPartial) doc.text(pdfSafe("Eslatma: davr 30 kundan uzoq: vazifa tokenlari faqat xom ma'lumot oynasi uchun; loyiha/mijoz jami to'liq."));
  if (dto.activeTimePartial) doc.text(pdfSafe("Eslatma: davr 90 kundan uzoq: faol vaqt to'liq emas (sessiya hodisalari saqlash muddati)."));
  for (const note of EXPORT_NOTES) doc.text(pdfSafe(note));
  doc.end();
  return done;
}
