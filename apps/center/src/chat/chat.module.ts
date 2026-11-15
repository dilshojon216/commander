import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../realtime/core.module.js';
import { ChatRelayService } from './chat-relay.service.js';

/** Chat oqimi relay'i (agentd <-> klient). DB'ga hech narsa yozmaydi (faqat sessiya qatorini o'qiydi va `chat.opened` auditi). */
@Module({
  imports: [CoreModule, IdentityModule],
  providers: [ChatRelayService],
  exports: [ChatRelayService],
})
export class ChatModule {}
