import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CreateTemplateBodySchema,
  IdempotencyKeySchema,
  ListTemplatesQuerySchema,
  RenderTemplateBodySchema,
  SendTemplatePromptBodySchema,
  UpdateTemplateBodySchema,
} from '@commander/contracts';
import type {
  CreateCommandResponse,
  CreateTemplateBody,
  ListTemplatesQuery,
  ListTemplatesResponse,
  RenderTemplateBody,
  RenderTemplateResponse,
  SendTemplatePromptBody,
  TemplateDto,
  UpdateTemplateBody,
} from '@commander/contracts';
import { AuditAction, NoAudit } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { TemplatesService } from './templates.service.js';
import type { TemplateActor } from './templates.service.js';

const IdParamSchema = z.uuid();
const actorOf = (p: Principal, req: Request): TemplateActor => ({ deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) });

/**
 * Prompt shablonlari (3.4). O'qish va render: `read`; yozish va sessiyaga yuborish: `control` (lockdown'da 403: guard).
 * Render qilingan matn faqat javobda (saqlanmaydi). `send-prompt` = `session.prompt` buyrug'i (201, biznes rad ham qator).
 */
@Controller('v1/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListTemplatesQuerySchema)) q: ListTemplatesQuery): Promise<ListTemplatesResponse> {
    return this.templates.list(q);
  }

  @Get(':id')
  @ClientAuth('read')
  get(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string): Promise<TemplateDto> {
    return this.templates.get(id);
  }

  @Post()
  @ClientAuth('control')
  @AuditAction('template.create')
  create(@Body(new ZodValidationPipe(CreateTemplateBodySchema)) body: CreateTemplateBody, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<TemplateDto> {
    return this.templates.create(body, actorOf(principal, req));
  }

  @Patch(':id')
  @ClientAuth('control')
  @AuditAction('template.update')
  update(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateTemplateBodySchema)) body: UpdateTemplateBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<TemplateDto> {
    return this.templates.update(id, body, actorOf(principal, req));
  }

  /** 200 `{deleted:true}` (dashboard proksisi bo'sh tanani ko'tarmaydi). */
  @Delete(':id')
  @ClientAuth('control')
  @AuditAction('template.delete')
  async remove(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<{ deleted: true }> {
    await this.templates.remove(id, actorOf(principal, req));
    return { deleted: true };
  }

  /** Preview / forma to'ldirish: hech narsa yozilmaydi (shu sabab auditsiz; o'qish scope). */
  @Post(':id/render')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('read')
  @NoAudit()
  render(@Param('id', new ZodValidationPipe(IdParamSchema)) id: string, @Body(new ZodValidationPipe(RenderTemplateBodySchema)) body: RenderTemplateBody): Promise<RenderTemplateResponse> {
    return this.templates.render(id, body);
  }

  @Post(':id/send-prompt')
  @ClientAuth('control')
  @AuditAction('template.send_prompt')
  sendPrompt(
    @Param('id', new ZodValidationPipe(IdParamSchema)) id: string,
    @Body(new ZodValidationPipe(SendTemplatePromptBodySchema)) body: SendTemplatePromptBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    return this.templates.sendPrompt(id, body, actorOf(principal, req), idempotencyKey);
  }
}
