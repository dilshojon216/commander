import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  CLIENT_DEVICE_KINDS,
  CLIENT_TOKEN_PREFIX,
  CLIENT_TOKEN_SCOPES,
} from '@commander/contracts';
import type { ClientDeviceKind, ClientTokenScope } from '@commander/contracts';
import { Device } from '../../database/entities/device.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { generateClientToken, safeEqual, sha256Hex } from '../common/crypto.util.js';

export interface RotatedToken extends IssuedToken {
  /** Eski token (`rotated_from`): `grace_ends_at`gacha ishlaydi, keyin `expired`; 0 soat = darhol bekor qilinadi (WS 4010). */
  rotated_from: string;
  grace_ends_at: string | null;
  stepup_exempt_inherited: boolean;
}

export const MAX_ROTATION_GRACE_HOURS = 24 * 30;

export type ClientAuthFailure = 'malformed' | 'unknown' | 'revoked' | 'expired';

/** L-23: yangi klient tokenlari sukut bo'yicha shuncha kun amal qiladi (muddatsiz token faqat aniq `neverExpires` bilan). */
export const DEFAULT_TOKEN_DAYS = 90;

export interface IssuedToken {
  id: string;
  token: string;
  kind: ClientDeviceKind;
  name: string;
  scopes: ClientTokenScope[];
  expires_at: string | null;
}

@Injectable()
export class ClientTokensService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async issue(input: { kind: string; name: string; scopes: string[]; expiresInDays?: number; neverExpires?: boolean }, via: string): Promise<IssuedToken> {
    if (!(CLIENT_DEVICE_KINDS as readonly string[]).includes(input.kind)) {
      throw new BadRequestException(`kind must be one of ${CLIENT_DEVICE_KINDS.join(', ')}`);
    }
    const name = input.name.trim();
    if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new BadRequestException('name must be 1-100 printable chars');
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0 || !scopes.every((s) => (CLIENT_TOKEN_SCOPES as readonly string[]).includes(s))) {
      throw new BadRequestException(`scopes must be a non-empty subset of ${CLIENT_TOKEN_SCOPES.join(', ')}`);
    }
    if (input.neverExpires && input.expiresInDays !== undefined) throw new BadRequestException('--no-expiry and --expires-days are mutually exclusive');
    // Sukut: 90 kun; muddatsiz faqat egasi aniq so'raganda (`neverExpires`).
    const days = input.neverExpires ? undefined : (input.expiresInDays ?? DEFAULT_TOKEN_DAYS);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      throw new BadRequestException('expires-days must be an integer 1-3650');
    }

    const token = generateClientToken();
    const kind = input.kind as ClientDeviceKind;
    const issued = await this.dataSource.transaction(async (m) => {
      const rows: Array<{ id: string; expires_at: Date | null }> = await m.query(
        `INSERT INTO devices (kind, name, token_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4::text[], CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
         RETURNING id, expires_at`,
        [kind, name, sha256Hex(token), scopes, days ?? null],
      );
      const row = rows[0]!;
      await this.audit.record(
        {
          actorKind: 'system',
          action: 'token.issued',
          target: row.id,
          details: { kind, name, scopes, expires_at: row.expires_at?.toISOString() ?? null, via, ...(input.neverExpires ? { never_expires: true } : {}) },
        },
        m,
      );
      return row;
    });
    return { id: issued.id, token, kind, name, scopes: scopes as ClientTokenScope[], expires_at: issued.expires_at?.toISOString() ?? null };
  }

  /**
   * Klient tokenini aylantiradi (5.1): bir xil kind/name/platform/scope'li YANGI token chiqariladi; eski token `graceHours`
   * dan keyin yaroqsiz bo'ladi (`expires_at = min(eski, now + grace)`: autentifikatsiya va 5 s sweep buni allaqachon
   * majburlaydi, alohida job kerak emas). `graceHours = 0`: eski token shu zahoti bekor qilinadi (revoke trigger WS'ni 4010
   * bilan uzadi). Eski public key (agar bor) yangi tokenga KO'CHIRILMAYDI (UNIQUE; klient qayta pairing orqali oladi).
   * Step-up istisnosi (egasi tanlagan, per-device) faqat `inheritStepUpExempt` bilan o'tadi.
   */
  async rotate(
    id: string,
    opts: { graceHours: number; expiresInDays?: number; inheritStepUpExempt?: boolean },
    via: string,
  ): Promise<RotatedToken> {
    const { graceHours, expiresInDays } = opts;
    if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > MAX_ROTATION_GRACE_HOURS) {
      throw new BadRequestException(`grace-hours must be a number 0-${MAX_ROTATION_GRACE_HOURS}`);
    }
    if (expiresInDays !== undefined && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) {
      throw new BadRequestException('expires-days must be an integer 1-3650');
    }
    const token = generateClientToken();
    return this.dataSource.transaction(async (m) => {
      const old = await m.getRepository(Device).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!old) throw new NotFoundException(`Token ${id} not found`);
      if (old.kind === 'agentd' || old.kind === 'telegram' || !old.tokenHash) {
        throw new BadRequestException(`Device ${id} (${old.kind}) has no rotatable client token`);
      }
      if (old.revokedAt) throw new BadRequestException(`Token ${id} is already revoked`);
      if (old.expiresAt && old.expiresAt.getTime() <= Date.now()) throw new BadRequestException(`Token ${id} has already expired`);

      const graceMs = Math.round(graceHours * 3_600_000);
      const rows: Array<{ id: string; expires_at: Date | null }> = await m.query(
        `INSERT INTO devices (kind, name, platform, token_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[],
                 CASE WHEN $6::int IS NOT NULL THEN now() + make_interval(days => $6::int) ELSE $7::timestamptz END)
         RETURNING id, expires_at`,
        [old.kind, old.name, old.platform, sha256Hex(token), old.scopes, expiresInDays ?? null, old.expiresAt],
      );
      const created = rows[0]!;

      let graceEndsAt: Date | null = null;
      if (graceMs === 0) {
        await m.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [id]);
      } else {
        // CTE: TypeORM `UPDATE ... RETURNING` natijani `[rows, count]` shaklida qaytaradi.
        const res: Array<{ expires_at: Date }> = await m.query(
          `WITH u AS (
             UPDATE devices SET expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + make_interval(secs => $2::double precision / 1000))
              WHERE id = $1 RETURNING expires_at)
           SELECT expires_at FROM u`,
          [id, graceMs],
        );
        graceEndsAt = res[0]!.expires_at;
      }

      let inherited = false;
      if (opts.inheritStepUpExempt) {
        const cur: Array<{ value: unknown }> = await m.query(`SELECT value FROM settings WHERE key = 'commands.stepup_exempt_device_ids' FOR UPDATE`);
        const list = cur[0]?.value;
        if (Array.isArray(list) && list.includes(id)) {
          await m.query(`UPDATE settings SET value = $1::jsonb, updated_at = now() WHERE key = 'commands.stepup_exempt_device_ids'`, [JSON.stringify([...list, created.id])]);
          inherited = true;
        }
      }

      await this.audit.record(
        {
          actorKind: 'system',
          action: 'token.rotated',
          target: created.id,
          details: { rotated_from: id, kind: old.kind, name: old.name, scopes: old.scopes, grace_hours: graceHours, grace_ends_at: graceEndsAt?.toISOString() ?? null, stepup_exempt_inherited: inherited, via },
        },
        m,
      );
      return {
        id: created.id,
        token,
        kind: old.kind as ClientDeviceKind,
        name: old.name ?? '',
        scopes: old.scopes as ClientTokenScope[],
        expires_at: created.expires_at?.toISOString() ?? null,
        rotated_from: id,
        grace_ends_at: graceEndsAt?.toISOString() ?? null,
        stepup_exempt_inherited: inherited,
      };
    });
  }

  /** Tokenni tekshiradi (DB'dan har safar: bekor qilish darhol kuchga kiradi). */
  async authenticate(raw: string): Promise<{ device: Device } | { failure: ClientAuthFailure }> {
    if (!raw.startsWith(CLIENT_TOKEN_PREFIX) || raw.length > 128) return { failure: 'malformed' };
    const hash = sha256Hex(raw);
    const device = await this.dataSource
      .getRepository(Device)
      .findOne({ where: { tokenHash: hash } });
    if (!device?.tokenHash || device.kind === 'agentd' || !safeEqual(device.tokenHash, hash)) return { failure: 'unknown' };
    if (device.revokedAt) return { failure: 'revoked' };
    if (device.expiresAt && device.expiresAt.getTime() <= Date.now()) return { failure: 'expired' };
    return { device };
  }

  async list(): Promise<Device[]> {
    return this.dataSource
      .getRepository(Device)
      .createQueryBuilder('d')
      .where(`d.kind <> 'agentd'`)
      .orderBy('d.created_at', 'DESC')
      .getMany();
  }
}
