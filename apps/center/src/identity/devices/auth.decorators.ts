import { SetMetadata, UseGuards, applyDecorators, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ClientTokenScope } from '@commander/contracts';
import { ClientTokenGuard, LOCKDOWN_EXEMPT_KEY, REQUIRED_SCOPES_KEY } from '../tokens/client-token.guard.js';
import type { Principal } from '../common/request-context.js';
import { DeviceSignatureGuard } from './device-signature.guard.js';

/** Faqat imzolangan agentd so'rovlari (X-Device-Id/X-Timestamp/X-Nonce/X-Signature). */
export const DeviceAuth = (): MethodDecorator & ClassDecorator => applyDecorators(UseGuards(DeviceSignatureGuard));

/** Faqat klient tokeni (Authorization: Bearer cmdr_...) va ko'rsatilgan scope'lar (hammasi; `admin` hammasini qamraydi). */
export const ClientAuth = (...scopes: ClientTokenScope[]): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(REQUIRED_SCOPES_KEY, scopes), UseGuards(ClientTokenGuard));

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest<Request>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without an auth guard');
  return principal;
});

/** Lockdown'da ham o'tadigan route (qarang `LOCKDOWN_EXEMPT_KEY`). Route o'zi lockdown'ni majburlashi shart. */
export const LockdownExempt = (): MethodDecorator & ClassDecorator => SetMetadata(LOCKDOWN_EXEMPT_KEY, true);
