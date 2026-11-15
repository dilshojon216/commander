import { BadRequestException, Body, Controller, Get, Headers, HttpStatus, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { IdempotencyKeySchema, InvestigateBodySchema, ListInvestigationsQuerySchema, PutInvestigationSettingsBodySchema } from '@commander/contracts';
import type {
  InvestigateBody,
  InvestigateResponse,
  InvestigationDto,
  InvestigationSettings,
  ListInvestigationsQuery,
  ListInvestigationsResponse,
  PutInvestigationSettingsBody,
} from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { InvestigationsService } from './investigations.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/**
 * Hodisadan tekshiruv (6.4). Boshlash/sozlash `control` (lockdown'da 403: guard), o'qish `read`. Hamma ishga tushirish
 * `commands` konveyeri orqali (imzo + audit + lokal siyosat + step-up). 409: `ops_folder_not_configured`, `already_investigating`.
 */
@Controller('v1/investigations')
export class InvestigationsController {
  constructor(private readonly investigations: InvestigationsService) {}

  @Post()
  @ClientAuth('control')
  @AuditAction('investigation.start')
  async start(
    @Body(new ZodValidationPipe(InvestigateBodySchema)) body: InvestigateBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvestigateResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    const out = await this.investigations.start(body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) }, idempotencyKey);
    res.status(HttpStatus.CREATED);
    return out;
  }

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListInvestigationsQuerySchema)) q: ListInvestigationsQuery): Promise<ListInvestigationsResponse> {
    return this.investigations.list(q);
  }

  @Get('settings')
  @ClientAuth('read')
  settings(): Promise<InvestigationSettings> {
    return this.investigations.getSettings();
  }

  @Put('settings')
  @ClientAuth('control')
  @AuditAction('investigation.settings')
  putSettings(@Body(new ZodValidationPipe(PutInvestigationSettingsBodySchema)) body: PutInvestigationSettingsBody): Promise<InvestigationSettings> {
    return this.investigations.putSettings(body);
  }

  @Get(':id')
  @ClientAuth('read')
  get(@Param('id', IdParam) id: string): Promise<InvestigationDto> {
    return this.investigations.get(id);
  }
}
