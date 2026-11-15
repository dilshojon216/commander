import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { HealthIncidentsService } from './health-incidents.service.js';
import { HealthThresholdsService } from './health-thresholds.service.js';
import { MachineHealthController } from './machine-health.controller.js';
import { MachineHealthService } from './machine-health.service.js';

/** 3.8: server salomatligi (ingest, REST, hodisalar, chegaralar). Telegram ogohlantirishlari: `HealthAlertsModule`. */
@Module({
  imports: [IdentityModule, CoreModule],
  controllers: [MachineHealthController],
  providers: [MachineHealthService, HealthIncidentsService, HealthThresholdsService],
  exports: [MachineHealthService, HealthIncidentsService, HealthThresholdsService],
})
export class MachineHealthModule {}
