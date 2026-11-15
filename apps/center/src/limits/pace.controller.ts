import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PaceOverrideBodySchema, PutPaceSettingsBodySchema } from '@commander/contracts';
import type { PaceOverrideBody, PaceSettingsResponse, PutPaceSettingsBody } from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { PaceService } from './pace.service.js';

/**
 * Haftalik limit tezligi sozlamalari (6.12). O'qish `read`; sozlamani o'zgartirish va "bugun uchun ruxsat" `control`
 * (lockdown'da 403; dashboard'da elevation majburiy). Audit yozuv bilan bir tranzaksiyada (shu sabab umumiy audit o'chirilgan).
 */
@Controller('v1/limits')
export class PaceController {
  constructor(private readonly pace: PaceService) {}

  @Get('pace-settings')
  @ClientAuth('read')
  get(): Promise<PaceSettingsResponse> {
    return this.pace.get();
  }

  @Put('pace-settings')
  @ClientAuth('control')
  @NoAudit()
  put(@Body(new ZodValidationPipe(PutPaceSettingsBodySchema)) body: PutPaceSettingsBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<PaceSettingsResponse> {
    return this.pace.put(body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }

  @Post('pace-override')
  @ClientAuth('control')
  @NoAudit()
  override(@Body(new ZodValidationPipe(PaceOverrideBodySchema)) body: PaceOverrideBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<PaceSettingsResponse> {
    return this.pace.override(body.reset === true, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
