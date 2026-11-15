import type { IncomingMessage } from 'node:http';
import { WebSocketGateway } from '@nestjs/websockets';
import type { OnGatewayConnection } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { CLIENT_LIMITS, CLIENT_WS_PATH, CLIENT_WS_SUBPROTOCOL } from '@commander/contracts';
import { RealtimeHubService } from './realtime-hub.service.js';

/**
 * `/ws/client`. Nest `@SubscribeMessage` ishlatilmaydi (kontrakt envelope'i); ulanishni `RealtimeHubService` yuritadi.
 * `handleProtocols`: faqat `commander.v1` tanlanadi: token tashuvchi `cmdr-token.*` elementi javobda qaytarilmaydi.
 */
@WebSocketGateway({
  path: CLIENT_WS_PATH,
  maxPayload: CLIENT_LIMITS.maxMessageBytes,
  handleProtocols: (protocols: Set<string>): string | false => (protocols.has(CLIENT_WS_SUBPROTOCOL) ? CLIENT_WS_SUBPROTOCOL : false),
})
export class ClientGateway implements OnGatewayConnection {
  constructor(private readonly hub: RealtimeHubService) {}

  handleConnection(client: WebSocket, req: IncomingMessage): void {
    this.hub.accept(client, req);
  }
}
