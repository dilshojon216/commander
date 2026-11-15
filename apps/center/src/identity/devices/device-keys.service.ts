import { verify as cryptoVerify } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KEY_ROTATION_MAX_SKEW_MS, buildKeyRotationString } from '@commander/contracts';
import type { KeyRotatePayload, KeyRotateResultPayload } from '@commander/contracts';
import { Device } from '../../database/entities/device.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { FixedWindowLimiter } from '../common/rate-limiter.js';
import { decodeRawEd25519PublicKey, ed25519PublicKeyFromRaw, sha256Hex } from '../common/crypto.util.js';
import { notifyDeviceEvent } from './device-events.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';
/** Qurilma bo'yicha: 10 daqiqada 10 ta urinish (muvaffaqiyatsizlari ham): imzo tekshiruvini aylantirish orqali tezlatmaslik. */
const ROTATE_LIMIT = 10;
const ROTATE_WINDOW_MS = 10 * 60_000;

export interface KeyRotateOutcome {
  ok: boolean;
  code?: NonNullable<KeyRotateResultPayload['code']>;
}

const fp = (raw: Buffer): string => sha256Hex(raw).slice(0, 16);

/**
 * Qurilma Ed25519 kalitini aylantirish (5.1). Agent HAM eski HAM yangi kalit bilan `buildKeyRotationString` ni imzolaydi
 * (autentifikatsiyalangan WS ustida): egalik isboti ikkala kalitga. Almashtirish atomik (`UPDATE ... WHERE public_key = <eski>`):
 * poyga yoki takror (replay) bo'lsa 0 qator, shuning uchun eski imzo yangi kalitdan keyin ishlamaydi. Audit shu tranzaksiyada.
 * Eski kalit shundan keyin `DeviceSignatureVerifier` tomonidan rad etiladi (kalit har safar DB'dan o'qiladi, kesh kalitga bog'liq).
 */
@Injectable()
export class DeviceKeysService {
  private readonly limiter = new FixedWindowLimiter(ROTATE_LIMIT, ROTATE_WINDOW_MS);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async rotate(deviceId: string, payload: KeyRotatePayload, via: string, nowMs: number = Date.now()): Promise<KeyRotateOutcome> {
    if (this.limiter.hit(deviceId, nowMs) > ROTATE_LIMIT) return { ok: false, code: 'rate_limited' };
    if (Math.abs(nowMs - payload.ts) > KEY_ROTATION_MAX_SKEW_MS) return { ok: false, code: 'stale_timestamp' };

    const newRaw = decodeRawEd25519PublicKey(payload.newPublicKey);
    if (!newRaw) return { ok: false, code: 'invalid_signature' };

    const device = await this.dataSource.getRepository(Device).findOneBy({ id: deviceId, kind: 'agentd' });
    if (!device?.publicKey) return { ok: false, code: 'invalid_signature' };
    if (device.revokedAt) return { ok: false, code: 'revoked' };
    if (device.publicKey.equals(newRaw)) return { ok: false, code: 'same_key' };

    const canonical = Buffer.from(
      buildKeyRotationString({ deviceId: device.id, oldPublicKey: device.publicKey.toString('base64url'), newPublicKey: payload.newPublicKey, ts: payload.ts }),
      'utf8',
    );
    let valid = false;
    try {
      valid =
        cryptoVerify(null, canonical, ed25519PublicKeyFromRaw(device.publicKey), Buffer.from(payload.oldSignature, 'base64url')) &&
        cryptoVerify(null, canonical, ed25519PublicKeyFromRaw(newRaw), Buffer.from(payload.newSignature, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, code: 'invalid_signature' };

    const oldKey = device.publicKey;
    try {
      return await this.dataSource.transaction(async (m) => {
        const rows: Array<{ id: string }> = await m.query(
          `WITH u AS (
             UPDATE devices SET public_key = $2, key_rotated_at = now(), rotation_required = false
              WHERE id = $1 AND public_key = $3 AND revoked_at IS NULL
              RETURNING id)
           SELECT id FROM u`,
          [device.id, newRaw, oldKey],
        );
        if (rows.length === 0) return { ok: false, code: 'conflict' } as const;
        await this.audit.record(
          {
            actorDeviceId: device.id,
            actorKind: 'agentd',
            action: 'device.key_rotated',
            target: device.id,
            details: { previous_fingerprint: fp(oldKey), new_fingerprint: fp(newRaw), via, was_required: device.rotationRequired },
          },
          m,
        );
        return { ok: true } as const;
      });
    } catch (err) {
      if ((err as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) return { ok: false, code: 'key_in_use' };
      throw err;
    }
  }

  /** Markaz tashabbusi (CLI): agentd keyingi/hozirgi ulanishda kalitni aylantiradi. Bekor qilingan qurilma uchun xato. */
  async requireRotation(id: string, via: string): Promise<Device> {
    return this.dataSource.transaction(async (m) => {
      const device = await m.getRepository(Device).findOne({ where: { id, kind: 'agentd' }, lock: { mode: 'pessimistic_write' } });
      if (!device) throw new NotFoundException(`Device ${id} not found (or not an agentd device)`);
      if (device.revokedAt) throw new BadRequestException(`Device ${id} is revoked`);
      await m.query(`UPDATE devices SET rotation_required = true WHERE id = $1`, [id]);
      await this.audit.record({ actorKind: 'system', action: 'device.rotation_required', target: id, details: { name: device.name, via } }, m);
      await notifyDeviceEvent(m, 'rotation_required', id);
      return { ...device, rotationRequired: true };
    });
  }
}
