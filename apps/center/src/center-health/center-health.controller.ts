import { Controller, Get } from '@nestjs/common';
import type { CenterHealthResponse } from '@commander/contracts';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { CenterHealthService } from './center-health.service.js';

/** Markaz o'z holati (5.5): dashboard "Markaz holati" kartasi. O'qish `read` scope. */
@Controller('v1/center')
export class CenterHealthController {
  constructor(private readonly health: CenterHealthService) {}

  /** Oxirgi tekshiruv natijasi (60 s'lik tsikl), ochiq hodisalar va oxirgi 24 soatda yopilganlar. */
  @Get('health')
  @ClientAuth('read')
  get(): Promise<CenterHealthResponse> {
    return this.health.snapshot();
  }
}
