import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { ExportFile, TimesheetDto, TimesheetExportQuery } from '@commander/contracts';
import { toCsv } from './csv.js';
import { TimesheetService } from './timesheet.service.js';
import { timesheetPdf } from './timesheet-pdf.js';
import { TIMESHEET_HEADERS, exportFilename, timesheetRows } from './timesheet-rows.js';
import { timesheetXlsx } from './xlsx.js';

export const EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const TYPES = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' } as const;

/** Timesheet eksport (CSV/XLSX/PDF): fayl JSON ichida base64 (dashboard proksi faqat JSON uzatadi). */
@Injectable()
export class ExportService {
  constructor(private readonly timesheet: TimesheetService) {}

  async export(q: TimesheetExportQuery, now: Date = new Date()): Promise<ExportFile> {
    const { format, ...rest } = q;
    const dto = await this.timesheet.build(rest, now);
    return this.render(dto, format);
  }

  async render(dto: TimesheetDto, format: TimesheetExportQuery['format']): Promise<ExportFile> {
    const buf =
      format === 'csv'
        ? Buffer.from(toCsv(TIMESHEET_HEADERS, timesheetRows(dto).map((r) => r.cells)), 'utf8')
        : format === 'xlsx'
          ? await timesheetXlsx(dto)
          : await timesheetPdf(dto);
    if (buf.length > EXPORT_MAX_BYTES) throw new PayloadTooLargeException({ error: 'export_too_large', message: 'Eksport hajmi chegaradan oshdi' });
    return { filename: exportFilename(dto, format), contentType: TYPES[format], sizeBytes: buf.length, dataBase64: buf.toString('base64') };
  }
}
