import PDFDocument from 'pdfkit';
import type { ClientReportModel } from '@commander/contracts';
import { pdfSafe } from '../pdf-text.js';
import { uzDay, uzHours, uzPeriod } from './html.js';

const MARGIN = 48;

function bullets(doc: InstanceType<typeof PDFDocument>, items: readonly string[]): void {
  doc.font('Helvetica').fontSize(10);
  if (items.length === 0) {
    doc.fillColor('#777777').text('-').fillColor('#000000');
    return;
  }
  for (const t of items) doc.text(pdfSafe(`•  ${t}`), { indent: 6, width: doc.page.width - MARGIN * 2 });
}

/** Mijoz hisoboti PDF (6.8): HTML bilan bir xil MODELdan (faqat tozalangan maydonlar). Matn `pdfSafe`dan o'tadi. */
export async function renderClientReportPdf(m: ClientReportModel): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: pdfSafe(`${m.title} - loyiha holati`), Creator: 'Commander' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const W = doc.page.width - MARGIN * 2;
  doc.font('Helvetica-Bold').fontSize(20).text(pdfSafe(m.title));
  doc.font('Helvetica').fontSize(10).fillColor('#555555').text(pdfSafe(`Loyiha holati hisoboti · ${uzPeriod(m.periodFrom, m.periodTo)}`)).fillColor('#000000');
  doc.moveDown(0.8);
  const p = m.progress;
  doc.font('Helvetica-Bold').fontSize(12).text(pdfSafe(`Bajarildi: ${p.percentDone}%  (bajarilgan ${p.done}, jarayonda ${p.inProgress}, qolgan ${p.remaining})`));
  if (m.activeSeconds !== null) doc.font('Helvetica').fontSize(10).text(pdfSafe(`Ishlangan vaqt: ${uzHours(m.activeSeconds)}`));
  // progress chizig'i
  const y = doc.y + 6;
  doc.rect(MARGIN, y, W, 12).fill('#dddddd');
  if (p.total > 0) {
    const wd = (p.done / p.total) * W;
    const wp = (p.inProgress / p.total) * W;
    doc.rect(MARGIN, y, wd, 12).fill('#2f9e63');
    doc.rect(MARGIN + wd, y, wp, 12).fill('#e0a020');
  }
  doc.fillColor('#000000');
  doc.y = y + 24;

  for (const g of m.groups) {
    if (doc.y > doc.page.height - 160) doc.addPage();
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).text(pdfSafe(g.name));
    if (g.closedInPeriod.length > 0) {
      doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10.5).text('Davr ichida bajarilgan');
      bullets(doc, g.closedInPeriod.map((t) => t.title));
    }
    doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10.5).text('Jarayonda');
    bullets(doc, g.inProgress.map((t) => t.title));
    doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10.5).text('Qolgan');
    bullets(doc, g.remaining.map((t) => t.title));
    doc.moveDown(0.2).font('Helvetica-Bold').fontSize(10.5).text('Bajarilgan (jami)');
    bullets(doc, g.done.map((t) => t.title));
  }
  if (m.summaries.length > 0) {
    doc.addPage().font('Helvetica-Bold').fontSize(14).text('Haftalik xulosa');
    for (const s of m.summaries) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(10.5).text(pdfSafe(`${uzDay(s.weekStart)} haftasi`));
      bullets(doc, s.lines);
    }
  }
  doc.moveDown(1).font('Helvetica').fontSize(8).fillColor('#777777').text(pdfSafe(`Hisobot ${uzDay(m.generatedDay)} sanasida yaratilgan. Faqat ko'rish uchun: kod, yozishmalar va ichki ma'lumotlar kiritilmagan.`));
  doc.end();
  return done;
}
