import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { WatchdogController } from './watchdog.controller.js';
import { WatchdogService } from './watchdog.service.js';

/** 3.2: qotib qolgan / ortiqcha sarflayotgan / xato takrorlayotgan sessiyalar detektori. */
@Module({
  imports: [IdentityModule, CoreModule, LimitsModule, CommandsModule, TelegramModule],
  controllers: [WatchdogController],
  providers: [WatchdogService],
  exports: [WatchdogService],
})
export class WatchdogModule {}
