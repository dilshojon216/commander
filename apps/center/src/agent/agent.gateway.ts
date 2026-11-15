import type { IncomingMessage } from 'node:http';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { AGENT_LIMITS, AGENT_WS_PATH } from '@commander/contracts';
import { AgentChannelService } from './agent-channel.service.js';

/**
 * agentd kanali. Nest'ning `@SubscribeMessage` marshrutlashi ishlatilmaydi (kontrakt `{v,id,type,ts,payload}`
 * envelope'i, Nest'ning `{event,data}` emas): har ulanishni `AgentChannelService` o'z kadr tsikli bilan yuritadi.
 * `maxPayload` ws darajasida (oshsa 1009 bilan yopiladi).
 */
@WebSocketGateway({ path: AGENT_WS_PATH, maxPayload: AGENT_LIMITS.maxMessageBytes })
export class AgentGateway implements OnGatewayConnection {
  constructor(private readonly channel: AgentChannelService) {}

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    this.channel.accept(client, req);
  }
}
