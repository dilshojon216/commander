import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ConfigSyncController } from './config-sync.controller.js';
import { ConfigSyncService } from './config-sync.service.js';

/** 3.7: sozlamalarni markazdan tarqatish (profillar, capture/diff/apply/rollback, drift). Telegram drift ogohlantirishi: `ConfigAlertsModule`. */
@Module({
  imports: [IdentityModule, CommandsModule],
  controllers: [ConfigSyncController],
  providers: [ConfigSyncService],
  exports: [ConfigSyncService],
})
export class ConfigSyncModule {}
