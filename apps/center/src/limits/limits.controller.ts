import { Controller, Get } from '@nestjs/common';
import type { LimitsResponse } from '@commander/contracts';
import { ClientAuth } from '../identity/devices/auth.decorators.js';
import { LimitsService } from './limits.service.js';

@Controller('v1/limits')
export class LimitsController {
  constructor(private readonly limits: LimitsService) {}

  /**
   * 5 soatlik va haftalik oyna. Mashinalar bo'ylab eng yangi RASMIY kuzatuv g'olib; reset o'tgan bo'lsa yoki
   * kuzatuv eskirgan bo'lsa `source='estimate'` (kalibrlash bilan) yoki eskirgan rasmiy qiymat (`stale=true`).
   */
  @Get()
  @ClientAuth('read')
  current(): Promise<LimitsResponse> {
    return this.limits.current();
  }
}
