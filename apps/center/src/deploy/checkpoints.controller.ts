import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CheckpointAutoSettingsSchema, CreateCheckpointBodySchema, IdempotencyKeySchema, RestoreCheckpointBodySchema } from '@commander/contracts';
import type { CheckpointAutoSettings, CheckpointListResult, CheckpointResult, CreateCheckpointBody, CreateCommandResponse, RestoreCheckpointBody } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import type { CommandActor } from '../commands/commands.service.js';
import { CheckpointsService } from './checkpoints.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

/**
 * Git checkpoint'lar (6.9). Yaratish/ro'yxat sinxron (`control`; ishchi daraxtga tegmaydi), qaytarish step-up (201 + buyruq).
 * Avto-checkpoint sozlamalari: `GET/PUT /v1/checkpoints/settings`.
 */
@Controller('v1')
export class CheckpointsController {
  constructor(private readonly checkpoints: CheckpointsService) {}

  @Post('projects/:id/checkpoints')
  @ClientAuth('control')
  @AuditAction('git.checkpoint')
  async create(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(CreateCheckpointBodySchema)) body: CreateCheckpointBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<{ commandId: string; result: CheckpointResult }> {
    return this.checkpoints.create(id, body.label, actorOf(principal, req));
  }

  @Post('projects/:id/checkpoints/list')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('git.checkpoint_list')
  list(@Param('id', IdParam) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<{ commandId: string; result: CheckpointListResult }> {
    return this.checkpoints.list(id, actorOf(principal, req));
  }

  @Post('projects/:id/checkpoints/restore')
  @ClientAuth('control')
  @AuditAction('git.checkpoint_restore')
  restore(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(RestoreCheckpointBodySchema)) body: RestoreCheckpointBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    return this.checkpoints.restore(id, body.ref, actorOf(principal, req), idempotencyKey);
  }

  @Get('checkpoints/settings')
  @ClientAuth('read')
  settings(): Promise<CheckpointAutoSettings> {
    return this.checkpoints.autoSettings();
  }

  @Put('checkpoints/settings')
  @ClientAuth('control')
  @AuditAction('checkpoints.settings')
  setSettings(@Body(new ZodValidationPipe(CheckpointAutoSettingsSchema)) body: CheckpointAutoSettings): Promise<CheckpointAutoSettings> {
    return this.checkpoints.setAutoSettings(body);
  }
}
