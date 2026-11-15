import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CreateOrchestrationBodySchema, ListOrchestrationsQuerySchema } from '@commander/contracts';
import type { CancelOrchestrationResponse, CreateOrchestrationBody, ListOrchestrationsQuery, ListOrchestrationsResponse, OrchestrationDto } from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { OrchError } from './orchestration-logic.js';
import { OrchestrationService } from './orchestration.service.js';
import type { OrchActor } from './orchestration.service.js';
import { HttpException } from '@nestjs/common';

const IdParamSchema = z.uuid();
const actorOf = (principal: Principal, req: Request): OrchActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

/**
 * Orkestratsiya (3.9). O'qish: `read`; boshlash va to'xtatish: `control`. Audit xizmat ichida (amal bilan atomik): `@NoAudit`.
 * "To'xtatish" lockdown'da ham ishlaydi (xavfsiz tomonga: sessiyalarni to'xtatadi, hech narsa ishga tushirmaydi).
 */
@Controller('v1/orchestrations')
@NoAudit()
export class OrchestrationController {
  constructor(private readonly orchestration: OrchestrationService) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListOrchestrationsQuerySchema)) q: ListOrchestrationsQuery): Promise<ListOrchestrationsResponse> {
    return this.orchestration.list(q);
  }

  @Get(':id')
  @ClientAuth('read')
  async get(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<OrchestrationDto> {
    return this.wrap(() => this.orchestration.getDto(id));
  }

  /** 201 yangi orkestratsiya (lead'ga boshlang'ich prompt yuborildi); 400 guruhga mos kelmagan lead/cwd; 404; 409 lead band; 422 prompt yuborib bo'lmadi. */
  @Post()
  @ClientAuth('control')
  async create(@Body(new ZodValidationPipe(CreateOrchestrationBodySchema)) body: CreateOrchestrationBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<OrchestrationDto> {
    return this.wrap(() => this.orchestration.create(body, actorOf(principal, req)));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  async cancel(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<CancelOrchestrationResponse> {
    return this.wrap(() => this.orchestration.cancel(id, actorOf(principal, req)));
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OrchError) {
        const status = err.code === 'orch_not_found' ? 404 : err.code === 'orch_forbidden' ? 403 : err.code === 'orch_conflict' || err.code === 'orch_limit' ? 409 : 400;
        throw new HttpException({ error: err.code, message: err.message }, status);
      }
      throw err;
    }
  }
}
