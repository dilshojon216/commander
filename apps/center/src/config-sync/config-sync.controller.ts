import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CaptureConfigBodySchema,
  ConfigApplyBodySchema,
  ConfigDiffBodySchema,
  ConfigFileContentQuerySchema,
  ConfigRollbackBodySchema,
  ConfigSettingsBodySchema,
  ConfigStatusQuerySchema,
  IdempotencyKeySchema,
} from '@commander/contracts';
import type {
  CaptureConfigBody,
  CaptureConfigResponse,
  ConfigApplyBody,
  ConfigDiffBody,
  ConfigDiffResponse,
  ConfigFileContentQuery,
  ConfigFileContentResponse,
  ConfigProfileDetail,
  ConfigRollbackBody,
  ConfigSettingsBody,
  ConfigSettingsResponse,
  ConfigStatusQuery,
  ConfigStatusResponse,
  CreateCommandResponse,
  ListConfigProfilesResponse,
} from '@commander/contracts';
import type { CommandActor } from '../commands/commands.service.js';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { ConfigSyncService } from './config-sync.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
const checkKey = (k: string | undefined): void => {
  if (k !== undefined && !IdempotencyKeySchema.safeParse(k).success) throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
};

/**
 * Sozlamalar sinxronlash (3.7). O'qish `read`; capture/diff/apply/rollback `control` (lockdown'da 403: guard) va audit qilinadi.
 * Agentga boradigan hamma amal `commands` konveyeri orqali (imzo + audit + lokal siyosat); haqiqiy qo'llash/qaytarish Telegram
 * step-up talab qiladi (Mac dashboard istisnosi bundan mustasno).
 */
@Controller('v1/config')
export class ConfigSyncController {
  constructor(private readonly config: ConfigSyncService) {}

  @Get('profiles')
  @ClientAuth('read')
  profiles(): Promise<ListConfigProfilesResponse> {
    return this.config.listProfiles();
  }

  @Get('profiles/:id')
  @ClientAuth('read')
  profile(@Param('id', IdParam) id: string): Promise<ConfigProfileDetail> {
    return this.config.profileDetail(id);
  }

  /** Fayl ko'ruvchi: `?path=agents/x.md`. */
  @Get('profiles/:id/file')
  @ClientAuth('read')
  file(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(ConfigFileContentQuerySchema)) q: ConfigFileContentQuery): Promise<ConfigFileContentResponse> {
    return this.config.fileContent(id, q.path);
  }

  /** Mashinadan yangi profil versiyasini oladi (sinxron, <= ~45 s). */
  @Post('profiles/capture')
  @HttpCode(HttpStatus.CREATED)
  @ClientAuth('control')
  @AuditAction('config.capture')
  capture(@Body(new ZodValidationPipe(CaptureConfigBodySchema)) body: CaptureConfigBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<CaptureConfigResponse> {
    return this.config.capture(body, actorOf(principal, req));
  }

  @Get('status')
  @ClientAuth('read')
  status(@Query(new ZodValidationPipe(ConfigStatusQuerySchema)) q: ConfigStatusQuery): Promise<ConfigStatusResponse> {
    return this.config.status(q.profile);
  }

  /** Dry-run diff (sinxron): hech narsa yozilmaydi. */
  @Post('machines/:machineId/diff')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('config.diff')
  diff(
    @Param('machineId', IdParam) machineId: string,
    @Body(new ZodValidationPipe(ConfigDiffBodySchema)) body: ConfigDiffBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<ConfigDiffResponse> {
    return this.config.diff(machineId, body, actorOf(principal, req));
  }

  @Post('machines/:machineId/apply')
  @ClientAuth('control')
  @AuditAction('config.apply')
  apply(
    @Param('machineId', IdParam) machineId: string,
    @Body(new ZodValidationPipe(ConfigApplyBodySchema)) body: ConfigApplyBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.config.apply(machineId, body, actorOf(principal, req), idempotencyKey);
  }

  @Post('machines/:machineId/rollback')
  @ClientAuth('control')
  @AuditAction('config.rollback')
  rollback(
    @Param('machineId', IdParam) machineId: string,
    @Body(new ZodValidationPipe(ConfigRollbackBodySchema)) body: ConfigRollbackBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.config.rollback(machineId, body, actorOf(principal, req), idempotencyKey);
  }

  @Get('settings')
  @ClientAuth('read')
  getSettings(): Promise<ConfigSettingsResponse> {
    return this.config.getSettings();
  }

  @Put('settings')
  @ClientAuth('control')
  @AuditAction('config.settings.update')
  putSettings(@Body(new ZodValidationPipe(ConfigSettingsBodySchema)) body: ConfigSettingsBody): Promise<ConfigSettingsResponse> {
    return this.config.putSettings(body);
  }
}
