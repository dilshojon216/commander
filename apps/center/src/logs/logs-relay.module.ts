import { Module } from '@nestjs/common';
import { CoreModule } from '../realtime/core.module.js';
import { LogsRelayService } from './logs-relay.service.js';

/** Log oqimi relay'i (agentd -> xotira buferi). `AgentModule` shuni import qiladi (modul sikli yo'q: buyruqlar bog'lanmaydi). */
@Module({ imports: [CoreModule], providers: [LogsRelayService], exports: [LogsRelayService] })
export class LogsRelayModule {}
