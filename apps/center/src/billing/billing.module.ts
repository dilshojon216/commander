import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { BillingController } from './billing.controller.js';
import { ClientReportController } from './client-report/client-report.controller.js';
import { ClientReportService } from './client-report/client-report.service.js';
import { ClientsService } from './clients.service.js';
import { ExportService } from './export.service.js';
import { TimesheetService } from './timesheet.service.js';

/** 6.7 Timesheet/xarajat hisoboti + 6.8 mijoz uchun statik hisobot. */
@Module({
  imports: [IdentityModule, TelegramModule],
  controllers: [BillingController, ClientReportController],
  providers: [ClientsService, TimesheetService, ExportService, ClientReportService],
  exports: [TimesheetService],
})
export class BillingModule {}
