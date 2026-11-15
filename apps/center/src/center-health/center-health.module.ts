import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandKeyModule } from '../commands/command-key.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { CenterHealthController } from './center-health.controller.js';
import { CENTER_HEALTH_OPTIONS, CENTER_PROBES, centerHealthOptionsFromConfig, centerProbesFromConfig } from './center-health.options.js';
import { CenterHealthService } from './center-health.service.js';
import { CenterIncidentsService } from './center-incidents.service.js';

/** 5.5: markazning o'z-o'zini kuzatishi (DB disk, zaxira, dashboard, Tailscale, jarayon, Telegram polling). */
@Module({
  imports: [IdentityModule, TelegramModule, CommandKeyModule],
  controllers: [CenterHealthController],
  providers: [
    { provide: CENTER_HEALTH_OPTIONS, inject: [ConfigService], useFactory: (c: ConfigService) => centerHealthOptionsFromConfig(c) },
    { provide: CENTER_PROBES, inject: [ConfigService], useFactory: (c: ConfigService) => centerProbesFromConfig(c) },
    CenterIncidentsService,
    CenterHealthService,
  ],
  exports: [CenterHealthService],
})
export class CenterHealthModule {}
