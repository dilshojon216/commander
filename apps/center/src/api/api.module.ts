import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { MachinesService } from './machines.service.js';
import { MachinesController, ProjectsController, SessionsV1Controller, UsageController } from './read-api.controllers.js';
import { SessionsV1Service } from './sessions-v1.service.js';
import { UsageService } from './usage.service.js';

/** 1.5: klient o'qish API'si (`/v1/machines|sessions|projects|usage`). `limits` va `approvals` o'z modullarida. */
@Module({
  imports: [IdentityModule],
  controllers: [MachinesController, SessionsV1Controller, ProjectsController, UsageController],
  providers: [MachinesService, SessionsV1Service, UsageService],
  exports: [MachinesService, SessionsV1Service, UsageService],
})
export class ApiModule {}
