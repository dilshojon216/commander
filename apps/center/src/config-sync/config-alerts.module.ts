import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { ConfigAlertsService } from './config-alerts.service.js';
import { ConfigSyncModule } from './config-sync.module.js';

/** 3.7: drift bo'yicha Telegram ogohlantirishi (ixtiyoriy, default o'chiq). */
@Module({ imports: [ConfigSyncModule, TelegramModule], providers: [ConfigAlertsService] })
export class ConfigAlertsModule {}
