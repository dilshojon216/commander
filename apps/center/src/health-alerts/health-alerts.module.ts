import { Module } from '@nestjs/common';
import { MachineHealthModule } from '../health/machine-health.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { HealthAlertsService } from './health-alerts.service.js';

/** 3.8: salomatlik chegaralari, hodisa holat mashinasi va Telegram ogohlantirishlari. */
@Module({ imports: [MachineHealthModule, TelegramModule], providers: [HealthAlertsService], exports: [HealthAlertsService] })
export class HealthAlertsModule {}
