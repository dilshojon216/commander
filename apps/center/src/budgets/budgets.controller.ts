import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BudgetOverrideBodySchema, PutBudgetBodySchema } from '@commander/contracts';
import type { BudgetOverrideBody, BudgetsResponse, PutBudgetBody } from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { BudgetsService } from './budgets.service.js';

/**
 * Kunlik byudjetlar (6.11). O'qish `read`; belgilash va "bugun uchun +X" `control` (lockdown'da 403; dashboard'da elevation majburiy).
 * Har yozuv audit'ga (`budget.set|removed|override`) yozuv bilan BIR tranzaksiyada tushadi (shu sabab umumiy audit o'chirilgan).
 */
@Controller('v1/budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @ClientAuth('read')
  status(): Promise<BudgetsResponse> {
    return this.budgets.status();
  }

  @Put()
  @ClientAuth('control')
  @NoAudit()
  put(@Body(new ZodValidationPipe(PutBudgetBodySchema)) body: PutBudgetBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<BudgetsResponse> {
    return this.budgets.put(body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }

  @Post('override')
  @ClientAuth('control')
  @NoAudit()
  override(@Body(new ZodValidationPipe(BudgetOverrideBodySchema)) body: BudgetOverrideBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<BudgetsResponse> {
    return this.budgets.override(body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
