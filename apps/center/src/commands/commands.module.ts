import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { CommandKeyModule } from './command-key.module.js';
import { CommandSignerService } from './command-signer.service.js';
import { CommandsController } from './commands.controller.js';
import { CommandsService } from './commands.service.js';
import { StepUpRegistry } from './step-up.js';

/** 2.3-2.7: remote buyruq konveyeri (REST, holat mashinasi, imzolangan dispatch, step-up reestri). */
@Module({
  imports: [IdentityModule, CoreModule, CommandKeyModule],
  controllers: [CommandsController],
  providers: [StepUpRegistry, CommandsService],
  exports: [CommandsService, CommandKeyModule, StepUpRegistry],
})
export class CommandsModule {}
