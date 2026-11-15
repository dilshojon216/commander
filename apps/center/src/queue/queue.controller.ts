import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CreateQueueItemBodySchema, ListQueueQuerySchema, UpdateQueueItemBodySchema } from '@commander/contracts';
import type {
  CreateQueueItemBody,
  ListQueueQuery,
  ListQueueResponse,
  QueueDetailResponse,
  QueueItemDto,
  UpdateQueueItemBody,
} from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { QueueSchedulerService } from './queue-scheduler.service.js';
import { QueueService } from './queue.service.js';
import type { QueueActor } from './queue.service.js';

const IdParamSchema = z.uuid();

const actorOf = (principal: Principal, req: Request): QueueActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

/**
 * Vazifalar navbati (3.1). O'qish: `read`; o'zgartirish: `control` (lockdown'da 403: guard). Yaratish/prompt o'zgartirish
 * `session.start` bilan BIR XIL step-up talab qiladi: istisno qurilma (Mac dashboard) o'tadi, boshqalar 422 `step_up_required`
 * (Telegram'dan `/new` oqimi orqali yaratiladi). Prompt API javobida HECH QACHON yo'q (faqat redakt qilingan ko'rinish).
 */
@Controller('v1/queue')
export class QueueController {
  constructor(
    private readonly queue: QueueService,
    private readonly scheduler: QueueSchedulerService,
  ) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListQueueQuerySchema)) q: ListQueueQuery): Promise<ListQueueResponse> {
    return this.queue.list(q);
  }

  @Get(':id')
  @ClientAuth('read')
  detail(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<QueueDetailResponse> {
    return this.queue.detail(id);
  }

  @Post()
  @ClientAuth('control')
  @AuditAction('queue.create')
  create(@Body(new ZodValidationPipe(CreateQueueItemBodySchema)) body: CreateQueueItemBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<QueueItemDto> {
    return this.queue.create(body, actorOf(principal, req));
  }

  @Patch(':id')
  @ClientAuth('control')
  @AuditAction('queue.update')
  update(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateQueueItemBodySchema)) body: UpdateQueueItemBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<QueueItemDto> {
    return this.queue.update(id, body, actorOf(principal, req));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('queue.cancel')
  cancel(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<QueueItemDto> {
    return this.queue.cancel(id, actorOf(principal, req));
  }

  @Post(':id/run-now')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('queue.run_now')
  async runNow(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<QueueItemDto> {
    await this.queue.markRunNow(id, actorOf(principal, req));
    await this.scheduler.tick().catch(() => false); // kutmasdan keyingi tikgacha emas, darhol (xato bo'lsa tik o'zi qayta urinadi)
    return this.queue.getDto(id);
  }

  /** Yakuniy elementni o'chiradi (200 `{deleted:true}`: dashboard proksisi bo'sh tanani ko'tarmaydi). */
  @Delete(':id')
  @ClientAuth('control')
  @AuditAction('queue.delete')
  async remove(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<{ deleted: true }> {
    await this.queue.remove(id, actorOf(principal, req));
    return { deleted: true };
  }
}
