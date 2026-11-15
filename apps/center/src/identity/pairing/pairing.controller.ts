import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ClientPairBodySchema } from '@commander/contracts';
import type { ClientPairBody, ClientPairResponse } from '@commander/contracts';
import { NoAudit } from '../audit/audit.decorators.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { PairingService } from './pairing.service.js';

@Controller('v1/clients')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  /**
   * Autentifikatsiyasiz: kirish huquqi bir martalik kod bilan beriladi (rate-limit + lockdown).
   * `@NoAudit`: audit yozuvlari servis ichida, pairing bilan bir tranzaksiyada. Javobda token (bir marta).
   */
  @Post('pair')
  @NoAudit()
  @HttpCode(HttpStatus.CREATED)
  pair(@Body(new ZodValidationPipe(ClientPairBodySchema)) body: ClientPairBody, @Req() req: Request): Promise<ClientPairResponse> {
    return this.pairing.pair(body, req);
  }
}
