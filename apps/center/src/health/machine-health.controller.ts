import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { HealthQuerySchema, ListHealthIncidentsQuerySchema, PutHealthThresholdsBodySchema } from '@commander/contracts';
import type {
  HealthQuery,
  HealthSummaryResponse,
  HealthThresholdsResponse,
  ListHealthIncidentsQuery,
  ListHealthIncidentsResponse,
  MachineHealthResponse,
  PutHealthThresholdsBody,
} from '@commander/contracts';
import { AuditAction } from '../identity/audit/audit.decorators.js';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { HealthIncidentsService } from './health-incidents.service.js';
import { HealthThresholdsService } from './health-thresholds.service.js';
import { MachineHealthService } from './machine-health.service.js';

const IdParam = new ZodValidationPipe(z.uuid());

/** Server salomatligi (3.8): o'qish `read`, chegaralarni o'zgartirish `admin` (audit qilinadi). */
@Controller('v1')
export class MachineHealthController {
  constructor(
    private readonly health: MachineHealthService,
    private readonly incidents: HealthIncidentsService,
    private readonly thresholds: HealthThresholdsService,
  ) {}

  /** Mashinaning oxirgi snapshot'i, grafik qatori (`range` 6h|24h|7d), hodisalari va amaldagi chegaralari. 404 `machine_not_found`. */
  @Get('machines/:id/health')
  @ClientAuth('read')
  machine(@Param('id', IdParam) id: string, @Query(new ZodValidationPipe(HealthQuerySchema)) q: HealthQuery): Promise<MachineHealthResponse> {
    return this.health.machineHealth(id, q.range);
  }

  /** Hamma mashinalar: qisqa holat va eng yomon holat. */
  @Get('health/summary')
  @ClientAuth('read')
  summary(): Promise<HealthSummaryResponse> {
    return this.health.summary();
  }

  @Get('health/incidents')
  @ClientAuth('read')
  async listIncidents(@Query(new ZodValidationPipe(ListHealthIncidentsQuerySchema)) q: ListHealthIncidentsQuery): Promise<ListHealthIncidentsResponse> {
    return { items: await this.incidents.list(q) };
  }

  @Get('health/thresholds')
  @ClientAuth('read')
  getThresholds(): Promise<HealthThresholdsResponse> {
    return this.thresholds.get();
  }

  /** `defaults` birlashtiriladi; `machines[id] = null` override'ni o'chiradi. */
  @Put('health/thresholds')
  @ClientAuth('admin')
  @AuditAction('health.thresholds.update')
  putThresholds(@Body(new ZodValidationPipe(PutHealthThresholdsBodySchema)) body: PutHealthThresholdsBody): Promise<HealthThresholdsResponse> {
    return this.thresholds.put(body);
  }
}
