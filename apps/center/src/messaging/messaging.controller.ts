import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  DeleteLinkQuerySchema,
  GroupKeyQuerySchema,
  ListMessagesQuerySchema,
  OwnerSendBodySchema,
  PatchGroupBodySchema,
  PutContextBodySchema,
  PutLinkBodySchema,
  PutMessagingSettingsBodySchema,
  PutRoleBodySchema,
  PutRulesBodySchema,
} from '@commander/contracts';
import type {
  DeleteLinkQuery,
  GroupDto,
  GroupKeyQuery,
  ListGroupsResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  MessagingSettings,
  OwnerSendBody,
  OwnerSendResponse,
  PatchGroupBody,
  PutContextBody,
  PutLinkBody,
  PutMessagingSettingsBody,
  PutRoleBody,
  PutRulesBody,
} from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { MessagingError, MessagingService } from './messaging.service.js';
import type { MessagingActor } from './messaging.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

const actorOf = (p: Principal, req: Request): MessagingActor => ({ deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) });

/** `MessagingError` -> HTTP: o'chiq = 409, tezlik = 429, qolgan biznes xatolar = 400. */
function mapError(err: unknown): never {
  if (err instanceof MessagingError) {
    const body = { error: err.code, message: err.message };
    if (err.code === 'messaging_disabled') throw new ConflictException(body);
    if (err.code === 'rate_limited') throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
    throw new BadRequestException(body);
  }
  throw err;
}

/**
 * Sessiyalararo xabar (task 2.10): dashboard uchun. Yozuvchi route'lar `control` scope (lockdown'da 403: guard), o'qish `read`.
 * Audit xizmat ichida, amal bilan BIR tranzaksiyada yoziladi (audit yozilmasa amal yo'q), shu sabab interceptor o'chirilgan.
 * Guruh kaliti `repo_key` bo'lgani uchun (`github.com/org/repo`) yo'lda emas, `key` parametrida (query/body) uzatiladi.
 */
@Controller('v1/messaging')
@NoAudit()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('settings')
  @ClientAuth('read')
  settings(): Promise<MessagingSettings> {
    return this.messaging.settings();
  }

  /** Global kill-switch. */
  @Put('settings')
  @ClientAuth('control')
  async putSettings(@Body(new ZodValidationPipe(PutMessagingSettingsBodySchema)) body: PutMessagingSettingsBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<MessagingSettings> {
    return this.messaging.setGlobalEnabled(body.enabled, actorOf(p, req));
  }

  @Get('groups')
  @ClientAuth('read')
  groups(): Promise<ListGroupsResponse> {
    return this.messaging.listGroups();
  }

  @Get('group')
  @ClientAuth('read')
  group(@Query(new ZodValidationPipe(GroupKeyQuerySchema)) q: GroupKeyQuery): Promise<GroupDto> {
    return this.messaging.getGroup(q.key);
  }

  /** Guruhni yoqish/o'chirish (kill-switch), auto-wake, Telegram savol xabari. */
  @Patch('groups')
  @ClientAuth('control')
  patch(@Body(new ZodValidationPipe(PatchGroupBodySchema)) body: PatchGroupBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<GroupDto> {
    const { key, ...patch } = body;
    return this.messaging.patchGroup(key, patch, actorOf(p, req));
  }

  @Put('groups/context')
  @ClientAuth('control')
  context(@Body(new ZodValidationPipe(PutContextBodySchema)) body: PutContextBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<GroupDto> {
    return this.messaging.putContext(body.key, body.context, actorOf(p, req));
  }

  @Put('groups/rules')
  @ClientAuth('control')
  rules(@Body(new ZodValidationPipe(PutRulesBodySchema)) body: PutRulesBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<GroupDto> {
    return this.messaging.putRules(body.key, body.rules, actorOf(p, req));
  }

  /** Egasi sessiya rolini belgilaydi (`role: null` = olib tashlash). */
  @Put('sessions/:id/role')
  @ClientAuth('control')
  role(@Param('id', IdParam) id: string, @Body(new ZodValidationPipe(PutRoleBodySchema)) body: PutRoleBody, @CurrentPrincipal() p: Principal, @Req() req: Request) {
    return this.messaging.putRole(id, body.role, actorOf(p, req));
  }

  /** Turli repo'larni bitta workspace guruhiga bog'laydi. */
  @Put('links')
  @ClientAuth('control')
  putLink(@Body(new ZodValidationPipe(PutLinkBodySchema)) body: PutLinkBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<ListGroupsResponse> {
    return this.messaging.putLink(body.baseKey, body.workspace, actorOf(p, req));
  }

  @Delete('links')
  @ClientAuth('control')
  deleteLink(@Query(new ZodValidationPipe(DeleteLinkQuerySchema)) q: DeleteLinkQuery, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<ListGroupsResponse> {
    return this.messaging.deleteLink(q.baseKey, actorOf(p, req));
  }

  @Get('messages')
  @ClientAuth('read')
  async messages(@Query(new ZodValidationPipe(ListMessagesQuerySchema)) q: ListMessagesQuery): Promise<ListMessagesResponse> {
    try {
      return await this.messaging.listMessages(q.key, q.limit, q.cursor);
    } catch (err) {
      return mapError(err);
    }
  }

  /** Egasi sifatida yuboradi (`fromRole = owner`). 201. Guruh o'chiq bo'lsa 409 `messaging_disabled`. */
  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  @ClientAuth('control')
  async send(@Body(new ZodValidationPipe(OwnerSendBodySchema)) body: OwnerSendBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<OwnerSendResponse> {
    try {
      return await this.messaging.ownerSend(body, actorOf(p, req));
    } catch (err) {
      return mapError(err);
    }
  }
}
