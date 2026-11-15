import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { COMMANDS_OPTIONS } from '../commands/commands.options.js';
import type { CommandsOptions } from '../commands/commands.options.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { QueueSchedulerService } from './queue-scheduler.service.js';
import { QueueController } from './queue.controller.js';
import { QUEUE_OPTIONS, queueOptionsFromConfig } from './queue.options.js';
import { QueueService } from './queue.service.js';

/** 3.1: vazifalar navbati (REST, scheduler, shifrlangan prompt). */
@Module({
  imports: [IdentityModule, CoreModule, CommandsModule, LimitsModule, BudgetsModule],
  controllers: [QueueController],
  providers: [
    { provide: QUEUE_OPTIONS, inject: [ConfigService, COMMANDS_OPTIONS], useFactory: (c: ConfigService, o: CommandsOptions) => queueOptionsFromConfig(c, o) },
    QueueService,
    QueueSchedulerService,
  ],
  exports: [QueueService, QueueSchedulerService],
})
export class QueueModule {}
