import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AskBodySchema,
  CreateDecisionBodySchema,
  ListDecisionsQuerySchema,
  PatchDecisionBodySchema,
  PutSummarySettingsBodySchema,
  SummarySearchQuerySchema,
} from '@commander/contracts';
import type {
  AskBody,
  AskHistoryResponse,
  AskResponse,
  CreateDecisionBody,
  DecisionDto,
  ListDecisionsQuery,
  ListDecisionsResponse,
  PatchDecisionBody,
  PutSummarySettingsBody,
  SessionSummaryResponse,
  SummarySearchQuery,
  SummarySearchResponse,
  SummarySettingsResponse,
} from '@commander/contracts';
import { NoAudit } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import { AskService } from './ask.service.js';
import { DecisionsService } from './decisions.service.js';
import { SummariesService } from './summaries.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const HistoryQuery = new ZodValidationPipe(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict());

/**
 * Aqlli yordamchi REST (6.1-6.3). O'qish `read`; yozish va savol `control` scope (lockdown'da guard 403 qaytaradi). Audit xizmatlar ichida
 * (amal bilan bir tranzaksiyada / `commands` konveyeri orqali), shu sabab interceptor o'chirilgan. Dashboard: sozlama va qarorlar
 * yozuvlari elevation talab qiladi (proxy-rules), savol yo'q (faqat o'qish).
 */
@Controller('v1')
@NoAudit()
export class IntelligenceController {
  constructor(
    private readonly summaries: SummariesService,
    private readonly decisions: DecisionsService,
    private readonly ask: AskService,
  ) {}

  @Get('summaries/search')
  @ClientAuth('read')
  async search(@Query(new ZodValidationPipe(SummarySearchQuerySchema)) q: SummarySearchQuery): Promise<SummarySearchResponse> {
    return { items: await this.summaries.search(q) };
  }

  @Get('summaries/settings')
  @ClientAuth('read')
  settings(): Promise<SummarySettingsResponse> {
    return this.summaries.settingsView();
  }

  @Put('summaries/settings')
  @ClientAuth('control')
  putSettings(@Body(new ZodValidationPipe(PutSummarySettingsBodySchema)) body: PutSummarySettingsBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<SummarySettingsResponse> {
    return this.summaries.putSettings(body, { deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) });
  }

  @Get('sessions/:id/summary')
  @ClientAuth('read')
  async sessionSummary(@Param('id', IdParam) id: string): Promise<SessionSummaryResponse> {
    return { summary: await this.summaries.forSession(id) };
  }

  @Post('assistant/ask')
  @ClientAuth('control')
  askQuestion(@Body(new ZodValidationPipe(AskBodySchema)) body: AskBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<AskResponse> {
    return this.ask.ask(body.question, { deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) }, 'dashboard');
  }

  @Get('assistant/history')
  @ClientAuth('read')
  async history(@Query(HistoryQuery) q: { limit: number }): Promise<AskHistoryResponse> {
    return { items: await this.ask.history(q.limit) };
  }

  @Get('projects/:id/decisions')
  @ClientAuth('read')
  async listDecisions(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(ListDecisionsQuerySchema)) q: ListDecisionsQuery): Promise<ListDecisionsResponse> {
    return { items: await this.decisions.list(id, q.status) };
  }

  @Post('projects/:id/decisions')
  @ClientAuth('control')
  createDecision(@Param('id', IdParam) id: string, @Body(new ZodValidationPipe(CreateDecisionBodySchema)) body: CreateDecisionBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<DecisionDto> {
    return this.decisions.create(id, body, { deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) });
  }

  @Patch('decisions/:id')
  @ClientAuth('control')
  patchDecision(@Param('id', IdParam) id: string, @Body(new ZodValidationPipe(PatchDecisionBodySchema)) body: PatchDecisionBody, @CurrentPrincipal() p: Principal, @Req() req: Request): Promise<DecisionDto> {
    return this.decisions.patch(id, body, { deviceId: p.device.id, actorKind: p.actorKind, ip: requestIp(req) });
  }
}
