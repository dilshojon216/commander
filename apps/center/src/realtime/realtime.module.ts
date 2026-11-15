import { ProjectsModule } from '../projects/projects.module.js';
import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { LimitsModule } from '../limits/limits.module.js';
import { MachineHealthModule } from '../health/machine-health.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { OrchestrationModule } from '../orchestration/orchestration.module.js';
import { CLIENT_HUB_OPTIONS, DEFAULT_CLIENT_HUB_OPTIONS } from './client-hub.options.js';
import { ClientGateway } from './client.gateway.js';
import { CoreModule } from './core.module.js';
import { RealtimeHubService } from './realtime-hub.service.js';

/** 1.6: `/ws/client` fan-out. */
@Module({
  imports: [CoreModule, IdentityModule, ApiModule, ApprovalsModule, LimitsModule, ChatModule, CommandsModule, ProjectsModule, MessagingModule, MachineHealthModule, QueueModule, OrchestrationModule],
  providers: [{ provide: CLIENT_HUB_OPTIONS, useValue: DEFAULT_CLIENT_HUB_OPTIONS }, RealtimeHubService, ClientGateway],
  exports: [RealtimeHubService],
})
export class RealtimeModule {}
