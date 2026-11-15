import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';

/** 2.10: sessiyalararo pochta qutisi (REST dashboard uchun; agent so'rovlari `AgentConnection` orqali `MessagingService.handleMailbox`ga keladi). */
@Module({
  imports: [IdentityModule, CoreModule, CommandsModule],
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
