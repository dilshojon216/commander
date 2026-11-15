import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CreateApprovalRuleBodySchema, ListApprovalRulesQuerySchema } from '@commander/contracts';
import type { CreateApprovalRuleBody, CreateApprovalRuleResponse, ListApprovalRulesQuery, ListApprovalRulesResponse, RevokeApprovalRuleResponse } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { ApprovalRulesService } from './approval-rules.service.js';

const RuleIdParamSchema = z.string().regex(/^[0-9]{1,18}$/);

/**
 * Avto-ruxsat qoidalari (2.13). O'qish: `read`; yaratish/bekor qilish: `control`.
 * Yaratish step-up talab qiladi (lokal dashboard istisnosi yoki Telegram); lockdown'da yaratish 403, bekor qilish RUXSAT.
 * Audit: interceptor `approval_rule.create|revoke` (request) + servis `approval_rule.created|revoked` (amal bilan atomik).
 */
@Controller('v1/approval-rules')
export class ApprovalRulesController {
  constructor(private readonly rules: ApprovalRulesService) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListApprovalRulesQuerySchema)) query: ListApprovalRulesQuery): Promise<ListApprovalRulesResponse> {
    return this.rules.list(query);
  }

  /** 201 yangi qoida; 400 yaroqsiz tana (Bash/shell vositalar, glob); 403 `step_up_required|lockdown`; 404 `scope_not_found`; 409 `too_many_rules`. */
  @Post()
  @ClientAuth('control')
  @AuditAction('approval_rule.create')
  async create(
    @Body(new ZodValidationPipe(CreateApprovalRuleBodySchema)) body: CreateApprovalRuleBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateApprovalRuleResponse> {
    return { rule: await this.rules.create(body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) }) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  @AuditAction('approval_rule.revoke')
  revoke(
    @Param('id', new ZodValidationPipe(RuleIdParamSchema)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<RevokeApprovalRuleResponse> {
    return this.rules.revoke(id, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
