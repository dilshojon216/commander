import { Module } from '@nestjs/common';
import { AgentDispatchService } from './agent-dispatch.service.js';
import { DeviceEventsListener } from './device-events.listener.js';
import { RealtimeBus } from './realtime-bus.js';

/** Jarayon ichidagi umumiy shinalar (hodisa shinasi va center->agent yuboruvchi). Bog'liqliksiz: modul sikllari yo'q. */
@Module({ providers: [RealtimeBus, AgentDispatchService, DeviceEventsListener], exports: [RealtimeBus, AgentDispatchService, DeviceEventsListener] })
export class CoreModule {}
