import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Request } from 'express';
import {
  CLIENT_PAIRING_DEFAULT_TTL_MINUTES,
  CLIENT_PAIRING_KINDS,
  CLIENT_PAIRING_MAX_TTL_MINUTES,
  CLIENT_PAIRING_TOKEN_DAYS,
  PAIRING_SCOPES,
} from '@commander/contracts';
import type { ClientDeviceKind, ClientPairBody, ClientPairResponse, ClientPairingKind, ClientTokenScope } from '@commander/contracts';
import { AuditService } from '../audit/audit.service.js';
import { decodeRawEd25519PublicKey, generateClientToken, generatePairingCode, hashEnrollmentCode, sha256Hex } from '../common/crypto.util.js';
import { requestIp, socketIp } from '../common/request-context.js';
import { SecurityEvents, tooMany } from '../common/security-events.service.js';
import { LockdownService } from '../lockdown/lockdown.service.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

class CodeRejected extends Error {
  constructor(
    readonly reason: 'unknown' | 'used' | 'expired',
    readonly codeId?: string,
  ) {
    super(reason);
  }
}

interface CodeRow {
  id: string;
  kind: ClientPairingKind;
  name: string;
  scopes: string[];
  token_days: number;
  used_at: Date | null;
  expired: boolean;
}

export interface CreatedPairingCode {
  id: string;
  code: string;
  kind: ClientPairingKind;
  name: string;
  scopes: ClientTokenScope[];
  expires_at: string;
  token_days: number;
}

/** Sof tekshiruv: scope ro'yxati (`admin` va noma'lumlar rad, takrorlar olib tashlanadi). */
export function normalizePairingScopes(scopes: readonly string[]): ClientTokenScope[] {
  const uniq = [...new Set(scopes.map((s) => s.trim()).filter(Boolean))];
  if (uniq.length === 0 || !uniq.every((s) => (PAIRING_SCOPES as readonly string[]).includes(s))) {
    throw new BadRequestException(`scopes must be a non-empty subset of ${PAIRING_SCOPES.join(', ')} (admin cannot be paired)`);
  }
  return uniq as ClientTokenScope[];
}

@Injectable()
export class PairingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: SecurityEvents,
    private readonly lockdown: LockdownService,
  ) {}

  /** Admin (faqat CLI). Kod faqat shu javobda ko'rinadi, DB'da xesh. */
  async createCode(
    input: { kind: string; name: string; scopes: string[]; ttlMinutes?: number; expiresDays?: number },
    via: string,
  ): Promise<CreatedPairingCode> {
    if (!(CLIENT_PAIRING_KINDS as readonly string[]).includes(input.kind)) {
      throw new BadRequestException(`kind must be one of ${CLIENT_PAIRING_KINDS.join(', ')}`);
    }
    const kind = input.kind as ClientPairingKind;
    const name = input.name.trim();
    if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new BadRequestException('name must be 1-100 printable chars');
    const scopes = normalizePairingScopes(input.scopes);
    const ttl = input.ttlMinutes ?? CLIENT_PAIRING_DEFAULT_TTL_MINUTES;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > CLIENT_PAIRING_MAX_TTL_MINUTES) {
      throw new BadRequestException(`ttl-minutes must be an integer 1-${CLIENT_PAIRING_MAX_TTL_MINUTES}`);
    }
    const days = input.expiresDays ?? CLIENT_PAIRING_TOKEN_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new BadRequestException('expires-days must be an integer 1-3650');

    const code = generatePairingCode();
    const row = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string; expires_at: Date }> = await m.query(
        `INSERT INTO client_pairing_codes (code_hash, kind, name, scopes, token_days, expires_at)
         VALUES ($1, $2, $3, $4::text[], $5, now() + make_interval(mins => $6::int))
         RETURNING id, expires_at`,
        [hashEnrollmentCode(code), kind, name, scopes, days, ttl],
      );
      const created = rows[0]!;
      await this.audit.record(
        {
          actorKind: 'system',
          action: 'pairing_code.created',
          target: created.id,
          details: { kind, name, scopes, ttl_minutes: ttl, token_days: days, expires_at: created.expires_at.toISOString(), via },
        },
        m,
      );
      return created;
    });
    return { id: row.id, code, kind, name, scopes, expires_at: row.expires_at.toISOString(), token_days: days };
  }

  /**
   * `POST /v1/clients/pair`. Kod faqat to'liq muvaffaqiyatda sarflanadi: kod qatori qulflanadi, qurilma yaratiladi,
   * kod sarflanadi va audit BITTA tranzaksiyada (audit yozilmasa pairing ham yo'q). Tashqariga barcha kod
   * xatolari bir xil 401; sabab (`unknown|used|expired`) auditda.
   */
  async pair(body: ClientPairBody, req: Request): Promise<ClientPairResponse> {
    const peer = socketIp(req);
    const { events } = this;
    const checks: Array<[typeof events.pairRequests, string]> = [
      [events.pairRequests, peer],
      [events.pairFailuresByIp, peer],
      [events.pairFailuresGlobal, 'global'],
    ];
    for (const [limiter, key] of checks) {
      if (limiter.isBlocked(key)) throw tooMany(limiter.retryAfterSeconds(key));
    }
    events.pairRequests.hit(peer);

    await this.lockdown.assertMutationAllowed(req);

    let publicKey: Buffer | null = null;
    if (body.publicKey !== undefined) {
      publicKey = decodeRawEd25519PublicKey(body.publicKey);
      if (!publicKey) {
        throw new BadRequestException({ error: 'invalid_public_key', message: 'publicKey must be a raw 32-byte Ed25519 key (base64/base64url)' });
      }
    }

    const ip = requestIp(req);
    try {
      return await this.dataSource.transaction((m) => this.pairTx(m, body, publicKey, ip));
    } catch (err) {
      if (err instanceof CodeRejected) {
        events.pairFailuresByIp.hit(peer);
        events.pairFailuresGlobal.hit('global');
        events.pairFailed(req, err.reason, err.codeId);
        throw new UnauthorizedException({ error: 'invalid_pairing_code', message: 'Pairing code is invalid, expired or already used' });
      }
      if (err instanceof ConflictException) events.pairFailed(req, 'conflict');
      throw err;
    }
  }

  private async pairTx(m: EntityManager, body: ClientPairBody, publicKey: Buffer | null, ip: string | null): Promise<ClientPairResponse> {
    const rows: CodeRow[] = await m.query(
      `SELECT id, kind, name, scopes, token_days, used_at, (expires_at <= now()) AS expired
         FROM client_pairing_codes WHERE code_hash = $1 FOR UPDATE`,
      [hashEnrollmentCode(body.code)],
    );
    const code = rows[0];
    if (!code) throw new CodeRejected('unknown');
    if (code.used_at) throw new CodeRejected('used', code.id);
    if (code.expired) throw new CodeRejected('expired', code.id);

    const token = generateClientToken();
    let device: { id: string; expires_at: Date | null; created_at: Date };
    try {
      const inserted: Array<{ id: string; expires_at: Date | null; created_at: Date }> = await m.query(
        `INSERT INTO devices (kind, name, platform, token_hash, scopes, public_key, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, now() + make_interval(days => $7::int))
         RETURNING id, expires_at, created_at`,
        [code.kind, body.deviceName, body.platform, sha256Hex(token), code.scopes, publicKey, code.token_days],
      );
      device = inserted[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        throw new ConflictException({ error: 'public_key_already_paired', message: 'This public key is already registered' });
      }
      throw err;
    }
    const used = await m.query(`UPDATE client_pairing_codes SET used_at = now(), used_by_device_id = $1 WHERE id = $2 AND used_at IS NULL`, [device.id, code.id]);
    // pg `UPDATE` natijasi [rows, affected]; FOR UPDATE qulfi tufayli doim 1, lekin himoya sifatida tekshiramiz.
    const affected = Array.isArray(used) ? Number(used[1]) : 0;
    if (affected !== 1) throw new CodeRejected('used', code.id);

    await this.audit.record({ actorKind: 'system', action: 'pairing_code.used', target: code.id, ip, details: { device_id: device.id } }, m);
    await this.audit.record(
      {
        actorDeviceId: device.id,
        actorKind: code.kind,
        action: 'device.paired',
        target: device.id,
        ip,
        details: { kind: code.kind, name: body.deviceName, platform: body.platform, scopes: code.scopes, expires_at: device.expires_at?.toISOString() ?? null },
      },
      m,
    );
    return {
      token,
      deviceId: device.id,
      kind: code.kind as ClientDeviceKind,
      name: body.deviceName,
      scopes: code.scopes as ClientTokenScope[],
      expiresAt: device.expires_at?.toISOString() ?? null,
      serverTime: new Date().toISOString(),
    };
  }
}
