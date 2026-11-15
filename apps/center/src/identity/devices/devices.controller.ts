import { Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import type { ClientDeviceMeResponse, ClientDeviceKind, ClientRevokeResponse, ClientTokenScope, DeviceMeResponse } from '@commander/contracts';
import { isStepUpExemptDevice } from '../../approvals/step-up-exempt.js';
import { requestIp } from '../common/request-context.js';
import type { Principal } from '../common/request-context.js';
import { ClientAuth, CurrentPrincipal, LockdownExempt } from './auth.decorators.js';
import { DeviceOrClientGuard } from './device-or-client.guard.js';
import { DevicesService } from './devices.service.js';

@Controller('v1/devices')
export class DevicesController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
  ) {}

  /**
   * Chaqiruvchi qurilma kimligi. agentd (imzo) -> snake_case `DeviceMeResponse` (o'zgarmagan);
   * klient tokeni (`Authorization: Bearer cmdr_...`, har qanday scope) -> camelCase `ClientDeviceMeResponse`.
   */
  @Get('me')
  @UseGuards(DeviceOrClientGuard)
  async me(@CurrentPrincipal() principal: Principal): Promise<DeviceMeResponse | ClientDeviceMeResponse> {
    const { device } = principal;
    if (principal.type === 'device') {
      return {
        device_id: device.id,
        machine_id: device.machineId,
        kind: device.kind,
        name: device.name,
        server_time: new Date().toISOString(),
      };
    }
    return {
      deviceId: device.id,
      kind: device.kind as ClientDeviceKind,
      name: device.name,
      platform: device.platform,
      scopes: principal.scopes as ClientTokenScope[],
      createdAt: device.createdAt.toISOString(),
      lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
      expiresAt: device.expiresAt?.toISOString() ?? null,
      stepUpExempt: await isStepUpExemptDevice(this.dataSource, device.id),
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Klient o'zini unpair qiladi: token darhol yaroqsiz (REST), ochiq `/ws/client` ulanishi hub sweep'ida
   * (~5 s) 4010 bilan uziladi. `@LockdownExempt`: o'zini o'chirish xavfsiz tomonga xato (hech narsa bajarmaydi).
   * Ikkinchi chaqiruv 401 (token endi bekor qilingan).
   */
  @Post('me/revoke')
  @HttpCode(HttpStatus.OK)
  @ClientAuth()
  @LockdownExempt()
  async revokeMe(@CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<ClientRevokeResponse> {
    await this.devices.revoke(principal.device.id, 'client', `self:${requestIp(req) ?? 'unknown'}`, {
      deviceId: principal.device.id,
      kind: principal.actorKind,
    });
    return { revoked: true, deviceId: principal.device.id };
  }
}
