import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { InvestigationsController } from './investigations.controller.js';
import { InvestigationsService } from './investigations.service.js';
import { InvestigationsTelegram } from './investigations-telegram.js';

/** 6.4: hodisadan tekshiruvga (server hodisasi / watchdog -> plan rejimidagi `session.start`). */
@Module({
  imports: [IdentityModule, CommandsModule],
  controllers: [InvestigationsController],
  providers: [InvestigationsService, InvestigationsTelegram],
  exports: [InvestigationsService],
})
export class InvestigationsModule {}
