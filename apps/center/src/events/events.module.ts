import { Module } from '@nestjs/common';
import { CoreModule } from '../realtime/core.module.js';
import { EventsService } from './events.service.js';

/** Sessiya hodisalarini yozish yadrosi (agentd WS yo'li ishlatadi). v0 `POST /events` va AUTH_TOKEN yo'li olib tashlangan (M-10). */
@Module({
  imports: [CoreModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
