import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { CreateCommandBodySchema, IdempotencyKeySchema, ListCommandsQuerySchema } from '@commander/contracts';
import type { CommandDto, CreateCommandBody, CreateCommandResponse, ListCommandsQuery, ListCommandsResponse } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { beforeStartHooks } from './before-start.js';
import { CommandsService } from './commands.service.js';
import type { ConfirmOutcome } from './commands.service.js';

const IdParamSchema = z.uuid();

/**
 * Remote buyruqlar. Hammasi `control` scope (o'qish `read`). Lockdown: yaratish va bekor qilish 403 (guard).
 * 201 yangi buyruq (biznes rad ham: `status` rejected|failed + `errorCode`), 200 idempotent takror,
 * 400 yaroqsiz tana, 404, 409 (`idempotency_conflict`, `command_in_flight`, `too_many_open_commands`), 429 `rate_limited`.
 */
@Controller('v1')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post('commands')
  @ClientAuth('control')
  @AuditAction('command.create')
  async create(
    @Body(new ZodValidationPipe(CreateCommandBodySchema)) body: CreateCommandBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreateCommandResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    const actor = { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) };
    let clean: CreateCommandBody = body;
    if (body.type === 'session.start' && body.checkpoint !== undefined) {
      // 6.9: "katta vazifa" shabloni: avto-checkpoint (sozlama yoqilgan bo'lsa; best-effort); bayroq buyruq tanasiga kirmaydi
      const { checkpoint, ...rest } = body;
      clean = rest;
      if (checkpoint) await beforeStartHooks.run({ kind: 'bigTask', machineId: body.machineId, cwd: body.cwd, label: body.name ?? 'session' }, actor);
    }
    const out = await this.commands.create(clean, actor, idempotencyKey);
    res.status(out.idempotent ? HttpStatus.OK : HttpStatus.CREATED);
    return out;
  }

  @Get('commands')
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListCommandsQuerySchema)) query: ListCommandsQuery): Promise<ListCommandsResponse> {
    return this.commands.list(query);
  }

  @Get('commands/:id')
  @ClientAuth('read')
  get(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<CommandDto> {
    return this.commands.getDto(id);
  }

  @Get('sessions/:id/commands')
  @ClientAuth('read')
  forSession(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<ListCommandsResponse> {
    return this.commands.listForSession(id);
  }

  /**
   * Dashboard tasdig'i (H-04/H-06): FAQAT `review.required` buyruqlar uchun (Telegram bu buyruqlarda "Tasdiqlash" bermaydi).
   * Boshqa step-up buyruqlari Telegram orqali tasdiqlanadi (409 `use_telegram`). `approve` scope, so'rovchi qurilma o'zini tasdiqlay olmaydi.
   */
  @Post('commands/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('approve')
  @AuditAction('command.confirm_request')
  confirm(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<{ outcome: ConfirmOutcome; command: CommandDto }> {
    return this.commands.confirmReviewed(id, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }

  /** Tasdiq kutayotgan buyruqni bekor qiladi (boshqa holatda `status` o'zgarmaydi, javob joriy holatni qaytaradi). */
  @Post('commands/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('command.cancel')
  async cancel(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<{ cancelled: boolean; command: CommandDto }> {
    return this.commands.cancel(id, { deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });
  }
}
