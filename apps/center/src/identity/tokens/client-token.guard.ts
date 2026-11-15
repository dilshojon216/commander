import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ClientDeviceKind, ClientTokenScope } from '@commander/contracts';
import { AuditService } from '../audit/audit.service.js';
import { extractBearer, isMutating, requestIp } from '../common/request-context.js';
import { SecurityEvents } from '../common/security-events.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { LockdownService } from '../lockdown/lockdown.service.js';
import { ClientTokensService } from './client-tokens.service.js';

export const REQUIRED_SCOPES_KEY = 'identity:required-scopes';
/**
 * `@LockdownExempt()`: route lockdown'da ham o'tadi (guard lockdown'ni tekshirmaydi). Faqat xavfsiz tomonga
 * xato qiladigan amallar uchun (masalan approval `deny`); route O'ZI lockdown qoidasini majburlashi shart.
 */
export const LOCKDOWN_EXEMPT_KEY = 'identity:lockdown-exempt';

export interface AuthenticateOptions {
  lockdownExempt?: boolean;
}

export const hasScopes = (granted: readonly string[], required: readonly string[]): boolean =>
  granted.includes('admin') || required.every((s) => granted.includes(s));

/** Bearer klient tokenini tekshiradigan umumiy servis (ClientTokenGuard va legacy ReadAccessGuard ishlatadi). */
@Injectable()
export class ClientAuthService {
  constructor(
    private readonly tokens: ClientTokensService,
    private readonly events: SecurityEvents,
    private readonly lockdown: LockdownService,
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
  ) {}

  /** Muvaffaqiyatda `req.principal`ni o'rnatadi; aks holda 401/403/429 tashlaydi. */
  async authenticate(req: Request, required: readonly ClientTokenScope[], options: AuthenticateOptions = {}): Promise<void> {
    const bearer = extractBearer(req);
    // M-08: qulf mijoz bo'yicha va faqat yaqinda ko'rilmagan token uchun; to'g'ri token to'fon ostida ham o'tadi.
    const credId = bearer ? SecurityEvents.bearerId(bearer) : undefined;
    this.events.assertAuthNotFlooded(req, credId);
    if (!bearer) {
      this.events.authFailed(req, { scheme: 'bearer', reason: 'missing' });
      throw new UnauthorizedException({ error: 'unauthorized', message: 'Missing bearer token' });
    }
    const result = await this.tokens.authenticate(bearer);
    if ('failure' in result) {
      this.events.authFailed(req, { scheme: 'bearer', reason: result.failure });
      throw new UnauthorizedException({ error: 'unauthorized', message: 'Invalid or missing bearer token' });
    }
    const { device } = result;
    this.events.markValid(credId as string);
    const scopes = device.scopes as ClientTokenScope[];
    const principal = { type: 'client' as const, actorKind: device.kind as ClientDeviceKind, device, scopes };

    if (!hasScopes(scopes, required)) {
      this.events.authFailed(req, { scheme: 'bearer', reason: 'insufficient_scope', claimedDeviceId: device.id });
      throw new ForbiddenException({ error: 'insufficient_scope', message: `Required scope: ${required.join(', ')}` });
    }
    if (isMutating(req.method) && !options.lockdownExempt) {
      try {
        await this.lockdown.assertMutationAllowed(req);
      } catch (err) {
        this.events.lockdownRejected(req, principal);
        throw err;
      }
    }
    req.principal = principal;
    if (await this.devices.touch(device)) {
      await this.audit.record({
        actorDeviceId: device.id,
        actorKind: principal.actorKind,
        action: 'token.first_used',
        target: device.id,
        ip: requestIp(req),
      });
    }
  }
}

@Injectable()
export class ClientTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clientAuth: ClientAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ClientTokenScope[] | undefined>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const lockdownExempt = this.reflector.getAllAndOverride<boolean | undefined>(LOCKDOWN_EXEMPT_KEY, [context.getHandler(), context.getClass()]) === true;
    await this.clientAuth.authenticate(context.switchToHttp().getRequest<Request>(), required ?? ['read'], { lockdownExempt });
    return true;
  }
}
