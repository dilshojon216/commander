import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  ListMachinesQuerySchema,
  ListProjectsQuerySchema,
  ListSessionEventsQuerySchema,
  ListSessionsQuerySchema,
  UpdateMachineBodySchema,
  UsageQuerySchema,
  isQueryFlagTrue,
} from '@commander/contracts';
import type {
  ListMachinesQuery,
  ListMachinesResponse,
  MachineArchiveResponse,
  MachineDto,
  UpdateMachineBody,
  ListProjectsQuery,
  ListProjectsResponse,
  ListSessionEventsQuery,
  ListSessionEventsResponseV1,
  ListSessionsQuery,
  ListSessionsResponseV1,
  SessionDto,
  UsageQuery,
  UsageResponse,
  UsageSummaryResponse,
} from '@commander/contracts';
import { AuditAction, NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { MachineAdminService } from './machine-admin.service.js';
import { MachinesService } from './machines.service.js';
import { SessionsV1Service } from './sessions-v1.service.js';
import { UsageService } from './usage.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/** Hamma `/v1` o'qish route'lari: Bearer klient tokeni, `read` scope, query Zod bilan tekshiriladi (noma'lum kalit = 400). */

@Controller('v1/machines')
export class MachinesController {
  constructor(
    private readonly machines: MachinesService,
    private readonly admin: MachineAdminService,
  ) {}

  /** online, last_seen, os, versiyalar, ochiq sessiyalar soni (holat bo'yicha). `?archived=1` = faqat arxivlanganlar (default: faollar). */
  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListMachinesQuerySchema)) q: ListMachinesQuery): Promise<ListMachinesResponse> {
    return this.machines.list(new Date(), isQueryFlagTrue(q.archived));
  }

  /**
   * N2.13 Nomini o'zgartirish: `control` scope (dashboard proksisida elevation talab qilinadi). Audit `machine.renamed` yozuv bilan
   * BIR tranzaksiyada (eski/yangi nom; shu sabab umumiy audit o'chirilgan). `@LockdownExempt`: masofaviy amal emas (mashinaga
   * hech narsa bormaydi), lockdown uni to'smaydi.
   */
  @Patch(':id')
  @ClientAuth('control')
  @LockdownExempt()
  @NoAudit()
  rename(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(UpdateMachineBodySchema)) body: UpdateMachineBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<MachineDto> {
    return this.admin.rename(id, body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }

  /**
   * N2.14 Arxivlash/qaytarish (projects 6.16 naqshi): `control` scope, audit `machine.archived|unarchived` (AuditInterceptor, amaldan
   * OLDIN, fail-closed), `@LockdownExempt` (ro'yxatdan yashirish xolos: ma'lumot o'chmaydi, qurilma revoke qilinmaydi).
   */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  @AuditAction('machine.archived')
  archive(@Param('id', IdParam) id: string): Promise<MachineArchiveResponse> {
    return this.admin.setArchived(id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  @AuditAction('machine.unarchived')
  unarchive(@Param('id', IdParam) id: string): Promise<MachineArchiveResponse> {
    return this.admin.setArchived(id, false);
  }
}

@Controller('v1/sessions')
export class SessionsV1Controller {
  constructor(private readonly sessions: SessionsV1Service) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListSessionsQuerySchema)) q: ListSessionsQuery): Promise<ListSessionsResponseV1> {
    return this.sessions.list(q);
  }

  @Get(':id')
  @ClientAuth('read')
  get(@Param('id', IdParam) id: string): Promise<SessionDto> {
    return this.sessions.get(id);
  }

  @Get(':id/events')
  @ClientAuth('read')
  events(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(ListSessionEventsQuerySchema)) q: ListSessionEventsQuery): Promise<ListSessionEventsResponseV1> {
    return this.sessions.listEvents(id, q);
  }
}

@Controller('v1/projects')
export class ProjectsController {
  constructor(private readonly usage: UsageService) {}

  /** Loyiha bo'yicha tokenlar: bugun (Asia/Tashkent) va umrbod. */
  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListProjectsQuerySchema)) q: ListProjectsQuery): Promise<ListProjectsResponse> {
    return this.usage.projects(q);
  }
}

@Controller('v1/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Vaqt qatori: bucket 5m|1h|1d, oraliq, guruhlash project|machine|model. */
  @Get()
  @ClientAuth('read')
  series(@Query(new ZodValidationPipe(UsageQuerySchema)) q: UsageQuery): Promise<UsageResponse> {
    return this.usage.series(q);
  }

  /** Bugun, 7 kun, 30 kun va umrbod jami (Asia/Tashkent kunlari). */
  @Get('summary')
  @ClientAuth('read')
  summary(): Promise<UsageSummaryResponse> {
    return this.usage.summary();
  }
}
