import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TelegramAccessModule } from '../telegram/telegram.module.js';
import { LogsController } from './logs.controller.js';
import { LogsRelayModule } from './logs-relay.module.js';
import { LogsService } from './logs.service.js';
import { LogsTelegram } from './logs-telegram.js';

/** 6.6: log ko'ruvchi (REST + Telegram `/logs`). Relay `LogsRelayModule` da (AgentModule uni ham import qiladi). */
@Module({
  imports: [IdentityModule, CommandsModule, LogsRelayModule, TelegramAccessModule],
  controllers: [LogsController],
  providers: [LogsService, LogsTelegram],
  exports: [LogsService],
})
export class LogsModule {}
