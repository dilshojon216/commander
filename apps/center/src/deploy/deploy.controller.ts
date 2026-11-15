import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { DeployInspectBodySchema, DeployOutputQuerySchema, DeployRunBodySchema, IdempotencyKeySchema } from '@commander/contracts';
import type { CreateCommandResponse, DeployInspectBody, DeployInspectResponse, DeployOutputQuery, DeployRunBody, DeployRunsResponse, LogsReadResponse } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import type { CommandActor } from '../commands/commands.service.js';
import { DeployService } from './deploy.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

function checkKey(k: string | undefined): void {
  if (k !== undefined && !IdempotencyKeySchema.safeParse(k).success) {
    throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
  }
}

/**
 * Bir bosishda deploy (6.5). Retsept repo'da (`.commander/deploy.yml`); markaz retsept matnini mijozdan QABUL QILMAYDI:
 *  - `inspect` (control, faqat o'qiydi): agent pin qilingan commit'dan o'qib normallashtirilgan retsept + xeshni qaytaradi;
 *  - `run` / `rollback` (control, step-up HAR DOIM, dashboard elevation majburiy): faqat (target, commit, recipeHash); 201 + buyruq,
 *    natija `command.updated` bilan, jonli chiqish `GET /v1/deploy/runs/:id/output?after=` (DB'ga yozilmaydi).
 * Lockdown'da yaratish 403 (guard). 409: `deploy_busy`, `commit_changed`, `recipe_changed`, `dirty_worktree`, `machine_mismatch`.
 */
@Controller('v1')
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  @Post('projects/:id/deploy/inspect')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('deploy.inspect')
  inspect(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(DeployInspectBodySchema)) body: DeployInspectBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<DeployInspectResponse> {
    return this.deploy.inspect(id, body.commit, actorOf(principal, req));
  }

  @Post('projects/:id/deploy/run')
  @ClientAuth('control')
  @AuditAction('deploy.run')
  run(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(DeployRunBodySchema)) body: DeployRunBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.deploy.run(id, body, actorOf(principal, req), idempotencyKey);
  }

  @Post('projects/:id/deploy/rollback')
  @ClientAuth('control')
  @AuditAction('deploy.rollback')
  rollback(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(DeployRunBodySchema)) body: DeployRunBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.deploy.rollback(id, body, actorOf(principal, req), idempotencyKey);
  }

  /** Tarix (chiqish saqlanmaydi: maqsad, commit, xesh, qadam holatlari). */
  @Get('projects/:id/deploy/runs')
  @ClientAuth('read')
  runs(@Param('id', IdParam) id: string): Promise<DeployRunsResponse> {
    return this.deploy.runs(id);
  }

  /** Jonli chiqish (cursor `?after=<nextSeq>`); javob `Cache-Control: no-store`. */
  @Get('deploy/runs/:commandId/output')
  @ClientAuth('read')
  output(
    @Param('commandId', IdParam) commandId: string,
    @Query(new ZodValidationPipe(DeployOutputQuerySchema)) q: DeployOutputQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogsReadResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.deploy.output(commandId, q.after);
  }
}
