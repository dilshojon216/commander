import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { DailyService } from './daily.service.js';
import { GitOpsController } from './git-ops.controller.js';
import { GIT_OPS_OPTIONS, gitOpsOptionsFromEnv } from './git-ops.options.js';
import { GitOpsService } from './git-ops.service.js';
import { PartsTelegram } from './parts-telegram.js';
import { ProjectPartsService } from './project-parts.service.js';
import { ProjectWorkController } from './project-work.controller.js';
import { ProjectWorkDataService } from './project-work-data.service.js';
import { ProjectWorkService } from './project-work.service.js';
import { ProjectSnapshotService } from './project-snapshot.service.js';
import { ProjectArchiveService } from './project-archive.service.js';
import { ProjectArchiveController, ProjectDetailController, TasksController } from './projects.controller.js';
import { ProjectsReadService } from './projects-read.service.js';
import { TaskSpansService } from './task-spans.service.js';
import { TaskStatsService } from './task-stats.service.js';

/** 2.1/2.2/2.8/2.9: loyiha snapshot'lari, vazifalar (TASKS.md) va vazifa bo'yicha token statistikasi. */
@Module({
  imports: [CoreModule, IdentityModule, ApiModule, CommandsModule],
  controllers: [ProjectDetailController, ProjectArchiveController, TasksController, ProjectWorkController, GitOpsController],
  providers: [ProjectArchiveService, ProjectPartsService, PartsTelegram, ProjectSnapshotService, TaskSpansService, TaskStatsService, ProjectWorkDataService, ProjectsReadService, DailyService, ProjectWorkService, GitOpsService, { provide: GIT_OPS_OPTIONS, useFactory: gitOpsOptionsFromEnv }],
  exports: [ProjectPartsService, ProjectSnapshotService, TaskSpansService, ProjectsReadService, GitOpsService],
})
export class ProjectsModule {}
