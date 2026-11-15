import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { TaskStatsService } from '../projects/task-stats.service.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsDataService } from './reports-data.service.js';
import { ReportsService } from './reports.service.js';

/** 3.3: kunlik/haftalik hisobotlar (Telegram + arxiv). */
@Module({
  imports: [IdentityModule, LimitsModule, TelegramModule],
  controllers: [ReportsController],
  providers: [TaskStatsService, ReportsDataService, ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
