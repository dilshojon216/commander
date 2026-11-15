import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { EnrollRequestSchema } from '@commander/contracts';
import type { EnrollRequest, EnrollResponse } from '@commander/contracts';
import { NoAudit } from '../audit/audit.decorators.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CommandSignerService } from '../../commands/command-signer.service.js';
import { EnrollmentService } from './enrollment.service.js';

@Controller('v1/enroll')
export class EnrollmentController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly signer: CommandSignerService,
  ) {}

  /**
   * Autentifikatsiyasiz: kirish huquqi bir martalik kod bilan beriladi (rate-limit + lockdown).
   * `@NoAudit`: audit yozuvlari servis ichida, enrollment bilan bir tranzaksiyada.
   */
  @Post()
  @NoAudit()
  @HttpCode(HttpStatus.CREATED)
  async enroll(@Body(new ZodValidationPipe(EnrollRequestSchema)) body: EnrollRequest, @Req() req: Request): Promise<EnrollResponse> {
    const res = await this.enrollment.enroll(body, req);
    // Markaz buyruq-imzo kalitini enrollment paytida beramiz: agentd uni PIN qiladi (TOFU emas).
    return { ...res, center_public_key: this.signer.publicKey };
  }
}
