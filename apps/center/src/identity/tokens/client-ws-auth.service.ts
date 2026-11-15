import type { IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
import type { ClientDeviceKind, ClientTokenScope } from '@commander/contracts';
import { AuditService } from '../audit/audit.service.js';
import { requestIp } from '../common/request-context.js';
import { SecurityEvents } from '../common/security-events.service.js';
import { DevicesService } from '../devices/devices.service.js';
import type { Device } from '../../database/entities/device.entity.js';
import { hasScopes } from './client-token.guard.js';
import { ClientTokensService } from './client-tokens.service.js';

export type ClientWsAuthResult =
  | { ok: true; device: Device; kind: ClientDeviceKind; scopes: ClientTokenScope[] }
  | { ok: false; code: 'unauthorized' | 'insufficient_scope' };

/**
 * `/ws/client` handshake auth'i: HTTP `ClientAuthService` bilan bir xil tekshiruvlar (token xeshi, revoke, muddat, scope,
 * `last_used_at`, birinchi ishlatish auditi), lekin Express `Request` siz. Token hech qachon logga yozilmaydi.
 */
@Injectable()
export class ClientWsAuthService {
  constructor(
    private readonly tokens: ClientTokensService,
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
    private readonly events: SecurityEvents,
  ) {}

  isFlooded(req: IncomingMessage): boolean {
    return this.events.isWsAuthFlooded(req);
  }

  async authenticate(raw: string, required: readonly ClientTokenScope[], req: IncomingMessage): Promise<ClientWsAuthResult> {
    const result = await this.tokens.authenticate(raw);
    if ('failure' in result) {
      this.events.clientWsAuthFailed(req, { reason: result.failure });
      return { ok: false, code: 'unauthorized' };
    }
    const { device } = result;
    this.events.markValid(SecurityEvents.bearerId(raw));
    const scopes = device.scopes as ClientTokenScope[];
    if (!hasScopes(scopes, required)) {
      this.events.clientWsAuthFailed(req, { reason: 'insufficient_scope', claimedDeviceId: device.id });
      return { ok: false, code: 'insufficient_scope' };
    }
    if (await this.devices.touch(device)) {
      await this.audit.record({ actorDeviceId: device.id, actorKind: device.kind as ClientDeviceKind, action: 'token.first_used', target: device.id, ip: requestIp(req) });
    }
    return { ok: true, device, kind: device.kind as ClientDeviceKind, scopes };
  }
}
