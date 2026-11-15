import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { LimitsController } from './limits.controller.js';
import { LimitsService } from './limits.service.js';

/** 1.5: limit holati (rasmiy + taxmin). */
@Module({ imports: [IdentityModule], controllers: [LimitsController], providers: [LimitsService], exports: [LimitsService] })
export class LimitsModule {}
