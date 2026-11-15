import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SIGNED_HEADERS } from '@commander/contracts';
import { AuditService } from '../audit/audit.service.js';
import { SecurityEvents } from '../common/security-events.service.js';
import { isMutating, requestIp } from '../common/request-context.js';
import { LockdownService } from '../lockdown/lockdown.service.js';
import { DevicesService } from './devices.service.js';
import { DeviceSignatureVerifier, SignatureError } from './device-signature.verifier.js';
import type { SignatureFailureReason } from './device-signature.verifier.js';

const MESSAGES: Record<SignatureFailureReason, string> = {
  missing_headers: 'Missing signature headers',
  malformed_headers: 'Malformed signature headers',
  body_unverifiable: 'Request body cannot be verified (send application/json)',
  stale_timestamp: 'Request timestamp is outside the allowed clock skew',
  unknown_device: 'Invalid signature',
  bad_signature: 'Invalid signature',
  device_revoked: 'Device revoked',
  replay: 'Nonce already used',
};

/**
 * agentd HTTP so'rovlarini imzo bo'yicha autentifikatsiya qiladi (`@DeviceAuth()`).
 * Muvaffaqiyatda `req.principal = { type: 'device', device }`. Lockdown: mutating so'rovlar 403.
 */
@Injectable()
export class DeviceSignatureGuard implements CanActivate {
  constructor(
    private readonly verifier: DeviceSignatureVerifier,
    private readonly events: SecurityEvents,
    private readonly lockdown: LockdownService,
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // M-08: to'fonda ham yaqinda muvaffaqiyatli o'tgan qurilma imzosi tekshiriladi (boshqalarning xatolari uni to'smaydi).
    const claimed = req.headers[SIGNED_HEADERS.deviceId];
    this.events.assertAuthNotFlooded(req, typeof claimed === 'string' ? `d:${claimed}` : undefined);

    const [path = '', rawQuery = ''] = splitUrl(req.originalUrl);
    const declaredLength = Number(req.headers['content-length'] ?? 0);

    let device;
    try {
      if (!req.rawBody && declaredLength > 0) throw new SignatureError('body_unverifiable');
      device = await this.verifier.verify({
        method: req.method,
        path,
        rawQuery,
        body: req.rawBody ?? Buffer.alloc(0),
        deviceId: req.headers[SIGNED_HEADERS.deviceId],
        timestamp: req.headers[SIGNED_HEADERS.timestamp],
        nonce: req.headers[SIGNED_HEADERS.nonce],
        signature: req.headers[SIGNED_HEADERS.signature],
      });
    } catch (err) {
      if (err instanceof SignatureError) {
        this.events.authFailed(req, { scheme: 'signature', reason: err.reason, claimedDeviceId: err.deviceId });
        throw new UnauthorizedException({ error: 'unauthorized', reason: err.reason === 'unknown_device' ? 'bad_signature' : err.reason, message: MESSAGES[err.reason] });
      }
      throw err;
    }

    this.events.markValid(`d:${device.id}`);
    const principal = { type: 'device' as const, actorKind: 'agentd' as const, device };
    if (isMutating(req.method)) {
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
        actorKind: 'agentd',
        action: 'device.first_used',
        target: device.id,
        ip: requestIp(req),
      });
    }
    return true;
  }
}

/** `/path?query` -> [path, rawQuery] (xom, decode qilinmagan). */
export function splitUrl(url: string): [string, string] {
  const i = url.indexOf('?');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}
