import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { GenerateReportBodySchema, ListReportsQuerySchema, ReportSettingsSchema } from '@commander/contracts';
import type { GenerateReportBody, ListReportsQuery, ListReportsResponse, ReportDto, ReportSettings } from '@commander/contracts';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { tashkentDayOf } from '../projects/tashkent-day.js';
import { ReportsService } from './reports.service.js';

/** 3.3: arxiv (`read`), sozlamalar (o'qish `read`, yozish `control`), qo'lda yaratish (`control`). `settings` yo'li `:id` dan oldin. */
@Controller('v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListReportsQuerySchema)) q: ListReportsQuery): Promise<ListReportsResponse> {
    return this.reports.list(q);
  }

  @Get('settings')
  @ClientAuth('read')
  getSettings(): Promise<ReportSettings> {
    return this.reports.getSettings();
  }

  @Put('settings')
  @ClientAuth('control')
  putSettings(@Body(new ZodValidationPipe(ReportSettingsSchema)) body: ReportSettings): Promise<ReportSettings> {
    return this.reports.putSettings(body);
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  generate(@Body(new ZodValidationPipe(GenerateReportBodySchema)) body: GenerateReportBody): Promise<ReportDto> {
    return this.reports.generate(body.kind, body.day ?? tashkentDayOf(new Date()), { send: body.send });
  }

  @Get(':id')
  @ClientAuth('read')
  get(@Param('id', new ZodValidationPipe(z.uuid())) id: string): Promise<ReportDto> {
    return this.reports.get(id);
  }
}
