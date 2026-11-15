import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { extractBearer } from '../common/request-context.js';
import { ClientAuthService } from '../tokens/client-token.guard.js';
import { DeviceSignatureGuard } from './device-signature.guard.js';

/**
 * Ikkala kimlik turi uchun bitta yo'l (`GET /v1/devices/me`): `Authorization: Bearer` bo'lsa klient tokeni
 * (scope talab qilinmaydi: har qanday yaroqli token o'zini ko'ra oladi), aks holda agentd imzosi.
 */
@Injectable()
export class DeviceOrClientGuard implements CanActivate {
  constructor(
    private readonly deviceGuard: DeviceSignatureGuard,
    private readonly clientAuth: ClientAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (extractBearer(req)) {
      await this.clientAuth.authenticate(req, []);
      return true;
    }
    return this.deviceGuard.canActivate(context);
  }
}
