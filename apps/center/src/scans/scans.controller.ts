import { BadRequestException, Body, Controller, Get, Headers, HttpStatus, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { IdempotencyKeySchema, PutScanSettingsBodySchema } from '@commander/contracts';
import type { PutScanSettingsBody, RunScanResponse, ScanDetail, ScanHistoryResponse, ScanListResponse, ScanSettings } from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import type { CommandActor } from '../commands/commands.service.js';
import { ScansService } from './scans.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const HistoryQuery = new ZodValidationPipe(z.object({ limit: z.coerce.number().int().min(1).max(60).optional() }).strict());
const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

/**
 * Xavfsizlik tekshiruvi (6.10). O'qish `read`; "Hozir tekshirish" `control` (masofaviy bajarish: lockdown'da 403; faqat o'qiydigan
 * imzolangan buyruq, audit `command.created`); sozlamalar `control` (dashboard'da elevation majburiy).
 */
@Controller('v1')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Get('scans')
  @ClientAuth('read')
  list(): Promise<ScanListResponse> {
    return this.scans.list();
  }

  @Get('scans/:id')
  @ClientAuth('read')
  detail(@Param('id', IdParam) id: string): Promise<ScanDetail> {
    return this.scans.detail(id);
  }

  @Get('projects/:id/scans')
  @ClientAuth('read')
  history(@Param('id', IdParam) id: string, @Query(HistoryQuery) q: { limit?: number }): Promise<ScanHistoryResponse> {
    return this.scans.history(id, q.limit);
  }

  @Post('projects/:id/scan')
  @ClientAuth('control')
  @NoAudit()
  async run(
    @Param('id', IdParam) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RunScanResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    const out = await this.scans.run(id, actorOf(principal, req), idempotencyKey);
    res.status(HttpStatus.CREATED);
    return out;
  }

  @Get('scan-settings')
  @ClientAuth('read')
  settings(): Promise<ScanSettings> {
    return this.scans.getSettings();
  }

  @Put('scan-settings')
  @ClientAuth('control')
  @NoAudit()
  putSettings(@Body(new ZodValidationPipe(PutScanSettingsBodySchema)) body: PutScanSettingsBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<ScanSettings> {
    return this.scans.putSettings(body, actorOf(principal, req));
  }
}
