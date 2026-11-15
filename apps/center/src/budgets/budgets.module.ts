import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { BudgetsController } from './budgets.controller.js';
import { BudgetsService } from './budgets.service.js';

/**
 * 6.11: kunlik byudjetlar (loyiha/mashina). Telegram bilan bog'liq qism (`BudgetAlertsModule`) ALOHIDA: navbat/orkestratsiya
 * bu modulni import qiladi, Telegram modul esa ularni (modul sikli bo'lmasin).
 */
@Module({
  imports: [IdentityModule, CommandsModule],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
