import { ProjectsModule } from '../projects/projects.module.js';
import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { LogsRelayModule } from '../logs/logs-relay.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { EventsModule } from '../events/events.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { MachineHealthModule } from '../health/machine-health.module.js';
import { ConfigSyncModule } from '../config-sync/config-sync.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { AGENT_CHANNEL_OPTIONS, DEFAULT_AGENT_CHANNEL_OPTIONS } from './agent-channel.options.js';
import { AgentChannelService } from './agent-channel.service.js';
import { AgentIngestService } from './agent-ingest.service.js';
import { AgentPresenceService } from './agent-presence.service.js';
import { AgentGateway } from './agent.gateway.js';

/** 1.4: agentd <-> center WS kanali (`/ws/agent`), ingest va presence. */
@Module({
  imports: [IdentityModule, EventsModule, ApprovalsModule, CoreModule, ChatModule, LogsRelayModule, CommandsModule, ProjectsModule, MessagingModule, MachineHealthModule, ConfigSyncModule],
  providers: [
    { provide: AGENT_CHANNEL_OPTIONS, useValue: DEFAULT_AGENT_CHANNEL_OPTIONS },
    AgentPresenceService,
    AgentIngestService,
    AgentChannelService,
    AgentGateway,
  ],
  exports: [AgentChannelService],
})
export class AgentModule {}
