import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandsModule } from '../commands/commands.module.js';
import { ApiModule } from '../api/api.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { DeployModule } from '../deploy/deploy.module.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { TelegramAccessService } from './telegram-access.service.js';
import { TELEGRAM_BOT, TELEGRAM_OPTIONS, createBot, telegramOptionsFromConfig } from './telegram.options.js';
import type { TelegramOptions } from './telegram.options.js';
import { TelegramService } from './telegram.service.js';

/** Allowlist/pairing: bot ham, admin CLI ham shuni ishlatadi (CLI'da bot ishga tushmaydi). */
@Module({ imports: [IdentityModule], providers: [TelegramAccessService], exports: [TelegramAccessService] })
export class TelegramAccessModule {}

/** 1.8: Telegram bot (grammY, long polling: inbound port yo'q). Token yo'q bo'lsa modul jim o'chiq turadi. */
@Module({
  imports: [TelegramAccessModule, IdentityModule, CoreModule, ApprovalsModule, ApiModule, LimitsModule, CommandsModule, MessagingModule, QueueModule, TemplatesModule, ProjectsModule, DeployModule],
  providers: [
    { provide: TELEGRAM_OPTIONS, inject: [ConfigService], useFactory: (c: ConfigService) => telegramOptionsFromConfig(c) },
    { provide: TELEGRAM_BOT, inject: [TELEGRAM_OPTIONS], useFactory: (o: TelegramOptions) => createBot(o) },
    TelegramService,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
