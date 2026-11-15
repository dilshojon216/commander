import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  ListProjectsQuerySchema,
  ListSessionEventsQuerySchema,
  ListSessionsQuerySchema,
  UsageQuerySchema,
} from '@commander/contracts';
import type {
  ListMachinesResponse,
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
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { MachinesService } from './machines.service.js';
import { SessionsV1Service } from './sessions-v1.service.js';
import { UsageService } from './usage.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/** Hamma `/v1` o'qish route'lari: Bearer klient tokeni, `read` scope, query Zod bilan tekshiriladi (noma'lum kalit = 400). */

@Controller('v1/machines')
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  /** online, last_seen, os, versiyalar, ochiq sessiyalar soni (holat bo'yicha). */
  @Get()
  @ClientAuth('read')
  list(): Promise<ListMachinesResponse> {
    return this.machines.list();
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
