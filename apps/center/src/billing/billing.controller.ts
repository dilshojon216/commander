import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CreateClientBodySchema, SetClientProjectsBodySchema, TimesheetExportQuerySchema, TimesheetQuerySchema, UpdateClientBodySchema } from '@commander/contracts';
import type { BillingProjectDto, ClientDto, CreateClientBody, ExportFile, ListBillingProjectsResponse, ListClientsResponse, SetClientProjectsBody, TimesheetDto, TimesheetExportQuery, TimesheetQuery, UpdateClientBody } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { ClientsService } from './clients.service.js';
import { ExportService } from './export.service.js';
import { TimesheetService } from './timesheet.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
export type { BillingProjectDto };

/**
 * 6.7 Hisob-kitob: mijozlar (CRUD: `control`, dashboard elevation), loyiha bog'lash, timesheet (`read`), eksport (`read`, audit).
 * Yo'l tartibi: statik yo'llar `:id` dan oldin.
 */
@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly clients: ClientsService,
    private readonly timesheet: TimesheetService,
    private readonly exports: ExportService,
  ) {}

  @Get('clients')
  @ClientAuth('read')
  list(): Promise<ListClientsResponse> {
    return this.clients.list();
  }

  @Get('projects')
  @ClientAuth('read')
  projects(): Promise<ListBillingProjectsResponse> {
    return this.clients.projects();
  }

  @Get('timesheet')
  @ClientAuth('read')
  sheet(@Query(new ZodValidationPipe(TimesheetQuerySchema)) q: TimesheetQuery): Promise<TimesheetDto> {
    return this.timesheet.build(q);
  }

  /** Fayl JSON ichida (base64): dashboard proksi faqat JSON uzatadi. Har eksport auditga yoziladi. */
  @Get('timesheet/export')
  @ClientAuth('read')
  @AuditAction('billing.export')
  export(@Query(new ZodValidationPipe(TimesheetExportQuerySchema)) q: TimesheetExportQuery): Promise<ExportFile> {
    return this.exports.export(q);
  }

  @Post('clients')
  @HttpCode(HttpStatus.CREATED)
  @ClientAuth('control')
  create(@Body(new ZodValidationPipe(CreateClientBodySchema)) body: CreateClientBody): Promise<ClientDto> {
    return this.clients.create(body);
  }

  @Patch('clients/:id')
  @ClientAuth('control')
  update(@Param('id', IdParam) id: string, @Body(new ZodValidationPipe(UpdateClientBodySchema)) body: UpdateClientBody): Promise<ClientDto> {
    return this.clients.update(id, body);
  }

  @Delete('clients/:id')
  @ClientAuth('control')
  remove(@Param('id', IdParam) id: string): Promise<{ deleted: true }> {
    return this.clients.remove(id);
  }

  @Put('clients/:id/projects')
  @ClientAuth('control')
  setProjects(@Param('id', IdParam) id: string, @Body(new ZodValidationPipe(SetClientProjectsBodySchema)) body: SetClientProjectsBody): Promise<ClientDto> {
    return this.clients.setProjects(id, body.projectKeys);
  }
}
