import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalDecisionBodySchema, ListApprovalsQuerySchema } from '@commander/contracts';
import type { ApprovalDecisionBody, ApprovalDecisionResponse, ApprovalDto, ListApprovalsQuery, ListApprovalsResponse } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from '../identity/devices/auth.decorators.js';
import type { Request } from 'express';
import { ApprovalsService } from './approvals.service.js';

const IdParamSchema = z.uuid();

/** Approval navbati. O'qish: `read`; qaror: `approve` (lockdown'da faqat `deny`, qarang ApprovalsService). */
@Controller('v1/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListApprovalsQuerySchema)) query: ListApprovalsQuery): Promise<ListApprovalsResponse> {
    return this.approvals.list(query);
  }

  @Get(':id')
  @ClientAuth('read')
  get(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<ApprovalDto> {
    return this.approvals.getDto(id);
  }

  /**
   * Birinchi qaror yutadi. 200: qabul qilindi (yoki shu qurilmaning aynan shu qarori takrori: `idempotent=true`);
   * 409 `approval_conflict` (boshqa qaror/qurilma, yoki cancelled/expired), 409 `approval_expired`;
   * 403 `lockdown` (lockdown'da `allow`); 404.
   * Audit: interceptor `approval.decision` (request) + servis `approval.decided` (qaror bilan bir tranzaksiyada).
   */
  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('approve')
  @LockdownExempt()
  @AuditAction('approval.decision')
  decide(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @Body(new ZodValidationPipe(ApprovalDecisionBodySchema)) body: ApprovalDecisionBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<ApprovalDecisionResponse> {
    return this.approvals.decide(id, body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
