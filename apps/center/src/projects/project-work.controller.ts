import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppendTasksBodySchema, DailyQuerySchema, DateParamSchema, IdempotencyKeySchema, MdExtractBodySchema, PatchBoardBodySchema, SummarizeDayBodySchema, TaskKeyAnySchema } from '@commander/contracts';
import type {
  AppendTasksBody,
  CreateCommandResponse,
  DailyQuery,
  DailyResponse,
  MdExtractBody,
  MdExtractResponse,
  MdFilesResponse,
  PatchBoardBody,
  ProjectPartsResponse,
  SummarizeDayBody,
  PatchBoardResponse,
} from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import type { CommandActor } from '../commands/commands.service.js';
import { DailyService } from './daily.service.js';
import { ProjectPartsService } from './project-parts.service.js';
import { ProjectWorkService } from './project-work.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const TaskKeyParam = new ZodValidationPipe(TaskKeyAnySchema);
const DateParam = new ZodValidationPipe(DateParamSchema);

const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

/**
 * Loyiha ish maydoni (2.15). Yozuvchi/boshqaruvchi route'lar `control` scope (lockdown'da 403: guard) va audit qilinadi;
 * o'qish `read`. Agentga boradigan hamma amal `commands` konveyeri orqali (imzo + audit + lokal siyosat).
 */
@Controller('v1/projects')
export class ProjectWorkController {
  constructor(
    private readonly work: ProjectWorkService,
    private readonly daily: DailyService,
    private readonly parts: ProjectPartsService,
  ) {}

  /** Doskada vazifani suradi. TASKS.md `done` vazifa surilmaydi (`changed=false`). 404 `task_not_found`. */
  @Patch(':id/tasks/:taskKey/board')
  @ClientAuth('control')
  @AuditAction('task.board.update')
  board(
    @Param('id', IdParam) id: string,
    @Param('taskKey', TaskKeyParam) taskKey: string,
    @Body(new ZodValidationPipe(PatchBoardBodySchema)) body: PatchBoardBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<PatchBoardResponse> {
    return this.work.setBoard(id, taskKey, body.column, actorOf(principal, req));
  }

  /** Loyiha qismlari (6.15): har qism progressi, sessiya/token/vaqt va "bajarilganlar xulosasi". Birinchisi ildiz ('asosiy'). */
  @Get(':id/parts')
  @ClientAuth('read')
  partsView(@Param('id', IdParam) id: string): Promise<ProjectPartsResponse> {
    return this.parts.list(id);
  }

  /** Kunlik ko'rinish (Asia/Tashkent): `?from=YYYY-MM-DD&to=YYYY-MM-DD` (default bugun, <= 62 kun). */
  @Get(':id/daily')
  @ClientAuth('read')
  dailyView(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(DailyQuerySchema)) q: DailyQuery): Promise<DailyResponse> {
    return this.daily.daily(id, q.from, q.to, q.part);
  }

  /** Kun xulosasi + baho: haiku (`project.summarize`); tanada `part` bo'lsa faqat shu qism (6.18). 201 + buyruq; natija `command.updated` va `project.updated` bilan keladi. */
  @Post(':id/daily/:date/summary')
  @ClientAuth('control')
  @AuditAction('project.summarize')
  summarize(
    @Param('id', IdParam) id: string,
    @Param('date', DateParam) date: string,
    @Body(new ZodValidationPipe(SummarizeDayBodySchema.default({}))) body: SummarizeDayBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    return this.work.summarize(id, date, actorOf(principal, req), new Date(), body.part);
  }

  @Get(':id/md-files')
  @ClientAuth('read')
  mdFiles(@Param('id', IdParam) id: string): Promise<MdFilesResponse> {
    return this.work.mdFiles(id);
  }

  /** `.md` -> nomzod vazifalar (deterministik parser). Agentdan faylni imzolangan `project.read_md` bilan oladi (<= 64 KB, redakt). */
  @Post(':id/md-extract')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('project.md_extract')
  mdExtract(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(MdExtractBodySchema)) body: MdExtractBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<MdExtractResponse> {
    return this.work.mdExtract(id, body, actorOf(principal, req));
  }

  /** TASKS.md'ga qator qo'shish (`project.append_tasks`, step-up). 201 + buyruq; xato `tasks_md_changed` buyruq natijasida. */
  @Post(':id/tasks/append')
  @ClientAuth('control')
  @AuditAction('project.append_tasks')
  append(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(AppendTasksBodySchema)) body: AppendTasksBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    if (idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
    }
    return this.work.append(id, body, actorOf(principal, req), idempotencyKey);
  }

  /** "TASKS.md'dan yangilash": agentd darhol snapshot yuboradi (`project.refresh`, faqat o'qish). */
  @Post(':id/refresh')
  @ClientAuth('control')
  @AuditAction('project.refresh')
  refresh(@Param('id', IdParam) id: string, @CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<CreateCommandResponse> {
    return this.work.refresh(id, actorOf(principal, req));
  }
}
