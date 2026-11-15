import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ListAlertsQuerySchema, WatchdogSettingsSchema } from '@commander/contracts';
import type { AlertDto, ListAlertsQuery, ListAlertsResponse, WatchdogSettings } from '@commander/contracts';
import { ZodValidationPipe } from '../identity/common/zod.pipe.js';
import { ClientAuth, LockdownExempt } from '../identity/devices/auth.decorators.js';
import { WatchdogService } from './watchdog.service.js';

const IdSchema = z.uuid();

/** 3.2: ogohlantirishlar (`read`), sozlamalar (o'qish `read`, yozish `control`), rad etish (`control`; lockdown'da ham mumkin: faqat ko'rinish). */
@Controller('v1')
export class WatchdogController {
  constructor(private readonly watchdog: WatchdogService) {}

  @Get('alerts')
  @ClientAuth('read')
  list(@Query(new ZodValidationPipe(ListAlertsQuerySchema)) q: ListAlertsQuery): Promise<ListAlertsResponse> {
    return this.watchdog.list(q);
  }

  @Post('alerts/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ClientAuth('control')
  @LockdownExempt()
  dismiss(@Param('id', new ZodValidationPipe(IdSchema)) id: string): Promise<AlertDto> {
    return this.watchdog.dismiss(id);
  }

  @Get('watchdog/settings')
  @ClientAuth('read')
  getSettings(): Promise<WatchdogSettings> {
    return this.watchdog.getSettings();
  }

  @Put('watchdog/settings')
  @ClientAuth('control')
  putSettings(@Body(new ZodValidationPipe(WatchdogSettingsSchema)) body: WatchdogSettings): Promise<WatchdogSettings> {
    return this.watchdog.putSettings(body);
  }
}
