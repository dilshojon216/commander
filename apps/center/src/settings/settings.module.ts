import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { StepUpExemptionController } from './stepup-exemption.controller.js';
import { StepUpExemptionService } from './stepup-exemption.service.js';

/** 6.17b: egasi sozlamalari (hozircha Telegram step-up istisnosi). */
@Module({
  imports: [IdentityModule],
  controllers: [StepUpExemptionController],
  providers: [StepUpExemptionService],
})
export class SettingsModule {}
