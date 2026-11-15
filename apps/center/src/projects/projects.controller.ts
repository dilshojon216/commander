import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ListProjectCommitsQuerySchema, ListTasksQuerySchema } from '@commander/contracts';
import type {
  ListProjectCommitsQuery,
  ListProjectCommitsResponse,
  ListTasksQuery,
  ListTasksResponse,
  ProjectArchiveResponse,
  ProjectDetailDto,
  ProjectTasksResponse,
} from '@commander/contracts';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ClientAuth, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { ProjectArchiveService } from './project-archive.service.js';
import { ProjectsReadService } from './projects-read.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/** `GET /v1/projects/:id[/tasks|/commits]` (ro'yxat `ProjectsController`da, api modulida). Bearer klient tokeni, `read` scope. */
@Controller('v1/projects')
export class ProjectDetailController {
  constructor(private readonly projects: ProjectsReadService) {}

  /** git ma'lumoti, oxirgi commitlar, TODOS.md/CHANGELOG.md matni, TASKS.md metadata'si. */
  @Get(':id')
  @ClientAuth('read')
  detail(@Param('id', IdParam) id: string): Promise<ProjectDetailDto> {
    return this.projects.detail(id);
  }

  /** TASKS.md vazifalari (todo|doing|done|unknown) + har vazifa uchun token/vaqt/sessiya statistikasi + "vazifasiz". */
  @Get(':id/tasks')
  @ClientAuth('read')
  tasks(@Param('id', IdParam) id: string): Promise<ProjectTasksResponse> {
    return this.projects.tasks(id);
  }

  @Get(':id/commits')
  @ClientAuth('read')
  commits(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(ListProjectCommitsQuerySchema)) q: ListProjectCommitsQuery): Promise<ListProjectCommitsResponse> {
    return this.projects.commits(id, q.limit);
  }
}

/**
 * 6.16 Arxivlash/qaytarish: `control` scope (dashboard proksisida elevation talab qilinadi). Audit: `project.archived|unarchived`
 * (AuditInterceptor, amaldan OLDIN, fail-closed). `@LockdownExempt`: bu masofaviy amal emas (mashinaga hech narsa bormaydi, ma'lumot
 * o'chmaydi, faqat ro'yxatdan yashirish), shuning uchun lockdown (masofaviy boshqaruvni to'xtatish) uni to'smaydi.
 */
@Controller('v1/projects')
export class ProjectArchiveController {
  constructor(private readonly archive: ProjectArchiveService) {}

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  @AuditAction('project.archived')
  archiveProject(@Param('id', IdParam) id: string): Promise<ProjectArchiveResponse> {
    return this.archive.setArchived(id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  @AuditAction('project.unarchived')
  unarchiveProject(@Param('id', IdParam) id: string): Promise<ProjectArchiveResponse> {
    return this.archive.setArchived(id, false);
  }
}

@Controller('v1/tasks')
export class TasksController {
  constructor(private readonly projects: ProjectsReadService) {}

  /** Vazifa kesimidagi statistika: `?project=<uuid|nom>`, `?repo=<repo_key>`, `?machine=`, `?from&to`. */
  @Get()
  @ClientAuth('read')
  summary(@Query(new ZodValidationPipe(ListTasksQuerySchema)) q: ListTasksQuery): Promise<ListTasksResponse> {
    return this.projects.taskSummary(q);
  }
}
