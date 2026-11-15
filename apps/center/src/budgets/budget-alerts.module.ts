import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { BudgetWatcherService } from './budget-watcher.service.js';
import { BudgetsModule } from './budgets.module.js';

/** 6.11: byudjet ogohlantirishlari va `/budget` (Telegram'ga bog'liq qism; `BudgetsModule`dan alohida: modul sikli yo'q). */
@Module({
  imports: [IdentityModule, CommandsModule, BudgetsModule, TelegramModule],
  providers: [BudgetWatcherService],
})
export class BudgetAlertsModule {}
