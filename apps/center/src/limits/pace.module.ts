import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { LimitsModule } from './limits.module.js';
import { PaceController } from './pace.controller.js';
import { PaceService } from './pace.service.js';

/** 6.12: haftalik limit tezligi sozlamalari + `session.start` darvozasi. Telegram qismi `PaceAlertsModule` da (modul sikli yo'q). */
@Module({
  imports: [IdentityModule, CoreModule, CommandsModule, LimitsModule],
  controllers: [PaceController],
  providers: [PaceService],
  exports: [PaceService],
})
export class PaceModule {}
