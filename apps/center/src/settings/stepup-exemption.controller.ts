import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { PutStepUpExemptionBodySchema } from '@commander/contracts';
import type { PutStepUpExemptionBody, StepUpExemptionResponse } from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { StepUpExemptionService } from './stepup-exemption.service.js';

/**
 * 6.17b Telegram step-up istisnosi. O'qish `read`; yozish `control` (dashboard proksisida elevation majburiy, fail-closed).
 * `@LockdownExempt`: bu masofaviy amal emas (mashinaga hech narsa bormaydi), shuning uchun istisnoni O'CHIRISH lockdown'da ham
 * ishlaydi (xavfsiz tomon). Lekin YOQISH xavfsizlikni yumshatadi: route buni o'zi majburlaydi (lockdown'da 403).
 * Audit (`settings.updated`) yozuv bilan bir tranzaksiyada (shu sabab umumiy audit o'chirilgan).
 */
@Controller('v1/settings')
export class StepUpExemptionController {
  constructor(
    private readonly exemption: StepUpExemptionService,
    private readonly lockdown: LockdownService,
  ) {}

  @Get('stepup-exemption')
  @ClientAuth('read')
  get(): Promise<StepUpExemptionResponse> {
    return this.exemption.get();
  }

  @Put('stepup-exemption')
  @ClientAuth('control')
  @LockdownExempt()
  @NoAudit()
  async put(
    @Body(new ZodValidationPipe(PutStepUpExemptionBodySchema)) body: PutStepUpExemptionBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<StepUpExemptionResponse> {
    if (body.exempt) await this.lockdown.assertMutationAllowed(req);
    return this.exemption.put(body.exempt, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
