import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { LimitsModule } from './limits.module.js';
import { PaceWatcherService } from './pace-watcher.service.js';

/** 6.12: haftalik tezlik ogohlantirishlari (Telegram'ga bog'liq qism; `PaceModule`dan alohida: modul sikli yo'q). */
@Module({
  imports: [IdentityModule, CoreModule, LimitsModule, TelegramModule],
  providers: [PaceWatcherService],
})
export class PaceAlertsModule {}
