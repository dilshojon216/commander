import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { IdempotencyKeySchema, LogsReadQuerySchema, StartLogsBodySchema } from '@commander/contracts';
import type { CreateCommandResponse, LogsReadQuery, LogsReadResponse, StartLogsBody } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { LogsService } from './logs.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/**
 * Log ko'ruvchi (6.6). Boshlash/to'xtatish `control` (lockdown'da 403: guard; har boshlash `commands` + `audit_log` da), o'qish `read`.
 * Elevation talab qilinmaydi (faqat o'qish), lekin autentifikatsiya shart. Log matni DB'ga yozilmaydi.
 * 201 yangi buyruq (biznes rad ham: `status` rejected|failed), 200 idempotent takror, 429 `rate_limited` | `logs_busy`.
 */
@Controller('v1')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Post('machines/:id/logs')
  @ClientAuth('control')
  @AuditAction('logs.start')
  async start(
    @Param('id', IdParam) machineId: string,
    @Body(new ZodValidationPipe(StartLogsBodySchema)) body: StartLogsBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateCommandResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    const out = await this.logs.start(machineId, body, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) }, idempotencyKey);
    res.status(out.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    return out;
  }

  /** Cursor bilan o'qish: `?after=<nextSeq>`. Javob `Cache-Control: no-store`. */
  @Get('logs/:commandId')
  @ClientAuth('read')
  read(
    @Param('commandId', IdParam) commandId: string,
    @Query(new ZodValidationPipe(LogsReadQuerySchema)) q: LogsReadQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogsReadResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.logs.read(commandId, q.after);
  }

  @Delete('logs/:commandId')
  @ClientAuth('control')
  @AuditAction('logs.stop')
  stop(@Param('commandId', IdParam) commandId: string): Promise<{ stopped: boolean }> {
    return this.logs.stop(commandId);
  }
}
