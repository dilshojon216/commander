import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ClientReportQuerySchema, CreateClientReportBodySchema } from '@commander/contracts';
import type { ClientReportPreview, ClientReportQuery, CreateClientReportBody, CreateClientReportResponse, ListClientReportSnapshotsResponse } from '@commander/contracts';
import { AuditAction } from '../../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../../identity/devices/auth.decorators.js';
import type { Principal } from '../../identity/common/request-context.js';
import { ClientReportService } from './client-report.service.js';

/**
 * 6.8 mijoz hisoboti: ko'rib chiqish (`read`, yon ta'sirsiz GET), yaratish (`control`: jurnalga yozadi, dashboard elevation),
 * jurnal (`read`). Hisobot FAYLI mijozga markazdan berilmaydi: egasi yuklab oladi va o'zi yuboradi.
 */
@Controller('v1/client-reports')
export class ClientReportController {
  constructor(private readonly reports: ClientReportService) {}

  @Get('preview')
  @ClientAuth('read')
  preview(@Query(new ZodValidationPipe(ClientReportQuerySchema)) q: ClientReportQuery): Promise<ClientReportPreview> {
    return this.reports.preview(q);
  }

  @Get()
  @ClientAuth('read')
  list(): Promise<ListClientReportSnapshotsResponse> {
    return this.reports.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ClientAuth('control')
  @AuditAction('client_report.create')
  create(@Body(new ZodValidationPipe(CreateClientReportBodySchema)) body: CreateClientReportBody, @CurrentPrincipal() principal: Principal): Promise<CreateClientReportResponse> {
    return this.reports.create(body, principal);
  }
}
