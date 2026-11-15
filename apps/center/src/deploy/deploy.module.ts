import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LogsRelayModule } from '../logs/logs-relay.module.js';
import { CheckpointsController } from './checkpoints.controller.js';
import { CheckpointsService } from './checkpoints.service.js';
import { DeployController } from './deploy.controller.js';
import { DeployService } from './deploy.service.js';

/** 6.5 bir bosishda deploy + 6.9 git checkpoint'lar (REST). Chiqish relay'i `LogsRelayModule`da (agentd `logs.chunk` -> xotira buferi). */
@Module({
  imports: [IdentityModule, CommandsModule, LogsRelayModule],
  controllers: [DeployController, CheckpointsController],
  providers: [DeployService, CheckpointsService],
  exports: [DeployService, CheckpointsService],
})
export class DeployModule {}
