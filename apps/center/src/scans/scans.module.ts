import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { ScanSchedulerService } from './scan-scheduler.service.js';
import { ScansController } from './scans.controller.js';
import { ScansService } from './scans.service.js';

/** 6.10: haftalik xavfsizlik/dependency tekshiruvi (`project.scan`), natijalar, rejalashtiruvchi va Telegram dayjest. */
@Module({
  imports: [IdentityModule, CommandsModule, TelegramModule],
  controllers: [ScansController],
  providers: [ScansService, ScanSchedulerService],
  exports: [ScansService],
})
export class ScansModule {}
