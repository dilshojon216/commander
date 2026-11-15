import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BudgetsModule } from '../budgets/budgets.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { OrchestrationNotifier } from './orchestration-notifier.js';
import { OrchestrationTelegram } from './orchestration-telegram.js';
import { OrchestrationController } from './orchestration.controller.js';
import { ORCH_OPTIONS, orchOptionsFromConfig } from './orchestration.options.js';
import { OrchestrationService } from './orchestration.service.js';

/** 3.9: ko'p sessiyali orkestratsiya (REST, lead/ishchi vositalari, kuzatuv, Telegram). */
@Module({
  imports: [IdentityModule, CoreModule, CommandsModule, MessagingModule, QueueModule, TelegramModule, BudgetsModule],
  controllers: [OrchestrationController],
  providers: [
    { provide: ORCH_OPTIONS, inject: [ConfigService], useFactory: (c: ConfigService) => orchOptionsFromConfig(c) },
    OrchestrationNotifier,
    OrchestrationService,
    OrchestrationTelegram,
  ],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
