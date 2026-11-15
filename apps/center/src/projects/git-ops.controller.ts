import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CiRefreshBodySchema, IdempotencyKeySchema, OpenPrBodySchema, ProjectDiffBodySchema } from '@commander/contracts';
import type { CiRefreshBody, CreateCommandResponse, DiffResponse, OpenPrBody, ProjectDiffBody, ProjectGitResponse } from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { requestIp } from '../identity/common/request-context.js';
import type { Principal } from '../identity/common/request-context.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, CurrentPrincipal } from '../identity/devices/auth.decorators.js';
import type { CommandActor } from '../commands/commands.service.js';
import { GitOpsService } from './git-ops.service.js';

const IdParam = new ZodValidationPipe(z.uuid());
const actorOf = (principal: Principal, req: Request): CommandActor => ({ deviceId: principal.device.id, actorKind: principal.actorKind, ip: requestIp(req) });

function checkKey(k: string | undefined): void {
  if (k !== undefined && !IdempotencyKeySchema.safeParse(k).success) {
    throw new BadRequestException({ error: 'invalid_request', message: 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_.:-]' });
  }
}

/**
 * Git/PR (3.5). Agentga boradigan hamma amal `commands` konveyeri orqali (imzo + audit + lokal siyosat). Diff va CI so'rovi
 * `control` scope (masofaviy bajarish: lockdown'da 403), faqat o'qish (`GET .../git`) `read`.
 */
@Controller('v1')
export class GitOpsController {
  constructor(private readonly git: GitOpsService) {}

  /** Loyiha diff'i (ishchi daraxt vs `HEAD` | `<sha>` | `merge-base:<branch>`): redakt qilingan, kesilgan, sinxron. */
  @Post('projects/:id/diff')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('project.diff')
  projectDiff(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(ProjectDiffBodySchema)) body: ProjectDiffBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<DiffResponse> {
    return this.git.diffForProject(id, body, actorOf(principal, req));
  }

  /** Sessiya diff'i: sessiya boshidagi git HEAD'dan hozirgacha (baza `baseSource` da ko'rsatiladi). */
  @Post('sessions/:id/diff')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @AuditAction('session.diff')
  sessionDiff(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(ProjectDiffBodySchema)) body: ProjectDiffBody,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<DiffResponse> {
    return this.git.diffForSession(id, body, actorOf(principal, req));
  }

  /** PR ochish (`project.open_pr`, step-up). 201 + buyruq; natija (URL/raqam) `command.updated` bilan keladi. */
  @Post('projects/:id/pr')
  @ClientAuth('control')
  @AuditAction('project.open_pr')
  openPr(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(OpenPrBodySchema)) body: OpenPrBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.git.openPr(id, body, actorOf(principal, req), idempotencyKey);
  }

  /** CI holatini hozir yangilash (`project.ci_status`, faqat o'qish). */
  @Post('projects/:id/ci/refresh')
  @ClientAuth('control')
  @AuditAction('project.ci_refresh')
  ciRefresh(
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(CiRefreshBodySchema)) body: CiRefreshBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<CreateCommandResponse> {
    checkKey(idempotencyKey);
    return this.git.refreshCi(id, body, actorOf(principal, req), idempotencyKey);
  }

  /** CI holati, PR'lar va vazifaga bog'langan commitlar. */
  @Get('projects/:id/git')
  @ClientAuth('read')
  gitState(@Param('id', IdParam) id: string): Promise<ProjectGitResponse> {
    return this.git.getGit(id);
  }
}
