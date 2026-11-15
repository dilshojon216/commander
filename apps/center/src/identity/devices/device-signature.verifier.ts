import { verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AGENT_AUTH_MAX_SKEW_MS,
  AgentSignatureSchema,
  SIGNATURE_MAX_SKEW_SECONDS,
  SignatureValueSchema,
  SignedNonceSchema,
  SignedTimestampSchema,
  buildAgentAuthString,
  buildCanonicalString,
} from '@commander/contracts';
import { Device } from '../../database/entities/device.entity.js';
import { ed25519PublicKeyFromRaw, sha256Hex } from '../common/crypto.util.js';

export type SignatureFailureReason =
  | 'missing_headers'
  | 'malformed_headers'
  | 'body_unverifiable'
  | 'stale_timestamp'
  | 'unknown_device'
  | 'bad_signature'
  | 'device_revoked'
  | 'replay';

export class SignatureError extends Error {
  constructor(
    readonly reason: SignatureFailureReason,
    readonly deviceId?: string,
  ) {
    super(reason);
  }
}

export interface VerifyInput {
  method: string;
  /** Xom yo'l (`?` gacha). */
  path: string;
  /** Xom query satri (`?`siz). */
  rawQuery: string;
  body: Buffer;
  /** Sarlavha qiymatlari (Node'dan kelgani kabi: string | string[] | undefined). */
  deviceId: unknown;
  timestamp: unknown;
  nonce: unknown;
  signature: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_TTL_SECONDS = SIGNATURE_MAX_SKEW_SECONDS * 2;
const NONCE_CLEANUP_MS = 60_000;
const KEY_CACHE_MAX = 256;

/**
 * Imzolangan so'rovni tekshiruvchi ODDIY servis (HTTP guard ham, kelajakdagi WS handshake ham
 * shuni ishlatadi). Tartib muhim:
 *   format -> soat farqi -> qurilmani topish -> imzo -> bekor qilinganmi -> nonce (replay).
 * Noma'lum qurilma va noto'g'ri imzo bir xil `bad_signature`/`unknown_device` (guard ularni bir xil
 * 401 qiladi); "revoked" va "replay" faqat IMZO TO'G'RI bo'lgandan keyin aniqlanadi, shuning uchun
 * kalitsiz hujumchi qurilma holatini bila olmaydi. Nonce faqat to'g'ri imzoli so'rovlar uchun
 * saqlanadi, shu sabab hujumchi jadvalni to'ldira olmaydi.
 *
 * Nonce'lar Postgres'da (`used_nonces`, PK(device_id, nonce)): jarayon restartidan omon qoladi
 * (xotira keshi bo'lsa restartdan keyingi 60 s oynada replay mumkin bo'lardi) va bir nechta
 * jarayon bilan ham ishlaydi. Narxi: har imzolangan so'rovga bitta INSERT, bu bitta foydalanuvchi
 * miqyosida arzon (heartbeat'lar WS orqali keladi).
 */
@Injectable()
export class DeviceSignatureVerifier {
  private readonly logger = new Logger(DeviceSignatureVerifier.name);
  private readonly keyCache = new Map<string, KeyObject>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async verify(input: VerifyInput, nowMs: number = Date.now()): Promise<Device> {
    const { deviceId, timestamp, nonce, signature } = input;
    if (deviceId === undefined || timestamp === undefined || nonce === undefined || signature === undefined) {
      throw new SignatureError('missing_headers');
    }
    if (typeof deviceId !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
      throw new SignatureError('malformed_headers');
    }
    if (
      !UUID_RE.test(deviceId) ||
      !SignedTimestampSchema.safeParse(timestamp).success ||
      !SignedNonceSchema.safeParse(nonce).success ||
      !SignatureValueSchema.safeParse(signature).success
    ) {
      throw new SignatureError('malformed_headers');
    }

    if (Math.abs(nowMs - Number(timestamp)) > SIGNATURE_MAX_SKEW_SECONDS * 1000) {
      throw new SignatureError('stale_timestamp');
    }

    const device = await this.dataSource.getRepository(Device).findOneBy({ id: deviceId.toLowerCase(), kind: 'agentd' });
    if (!device?.publicKey) throw new SignatureError('unknown_device');

    const canonical = buildCanonicalString({
      method: input.method,
      path: input.path,
      rawQuery: input.rawQuery,
      bodySha256: sha256Hex(input.body),
      timestamp,
      nonce,
      deviceId,
    });
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(canonical, 'utf8'), this.keyFor(device), Buffer.from(signature, 'base64url'));
    } catch {
      valid = false; // buzuq kalit/imzo: baribir rad
    }
    if (!valid) throw new SignatureError('bad_signature', device.id);

    if (device.revokedAt) throw new SignatureError('device_revoked', device.id);

    if (!(await this.consumeNonce(device.id, nonce))) throw new SignatureError('replay', device.id);
    return device;
  }

  /**
   * WS challenge-response (`/ws/agent`): imzo `buildAgentAuthString({nonce, ts, deviceId})` ustida.
   * Nonce'ni server ulanish boshida yaratadi va ulanish BIR MARTA sarflaydi (replay: boshqa ulanishda
   * boshqa nonce), shu sabab `used_nonces` kerak emas. Tartib va xato semantikasi HTTP bilan bir xil:
   * soat farqi -> qurilma (kind agentd) -> imzo -> bekor qilinganmi.
   */
  async verifyAgentChallenge(
    input: { deviceId: string; ts: number; signature: string; nonce: string },
    nowMs: number = Date.now(),
  ): Promise<Device> {
    if (!UUID_RE.test(input.deviceId) || !AgentSignatureSchema.safeParse(input.signature).success) {
      throw new SignatureError('malformed_headers');
    }
    if (Math.abs(nowMs - input.ts) > AGENT_AUTH_MAX_SKEW_MS) throw new SignatureError('stale_timestamp');

    const device = await this.dataSource.getRepository(Device).findOneBy({ id: input.deviceId.toLowerCase(), kind: 'agentd' });
    if (!device?.publicKey) throw new SignatureError('unknown_device');

    const canonical = buildAgentAuthString({ nonce: input.nonce, ts: input.ts, deviceId: device.id });
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(canonical, 'utf8'), this.keyFor(device), Buffer.from(input.signature, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) throw new SignatureError('bad_signature', device.id);
    if (device.revokedAt) throw new SignatureError('device_revoked', device.id);
    return device;
  }

  /** Ulangan agentd hali bekor qilinmaganmi (har heartbeat'da tekshiriladi: revoke tez kuchga kiradi). */
  async isRevoked(deviceId: string): Promise<boolean> {
    const row = await this.dataSource.getRepository(Device).findOne({ where: { id: deviceId }, select: { id: true, revokedAt: true } });
    return !row || row.revokedAt !== null;
  }

  private keyFor(device: Device): KeyObject {
    const cacheKey = `${device.id}:${device.publicKey!.toString('hex')}`;
    let key = this.keyCache.get(cacheKey);
    if (!key) {
      key = ed25519PublicKeyFromRaw(device.publicKey!);
      if (this.keyCache.size >= KEY_CACHE_MAX) this.keyCache.clear();
      this.keyCache.set(cacheKey, key);
    }
    return key;
  }

  /** `true` = nonce yangi (endi band), `false` = replay. */
  private async consumeNonce(deviceId: string, nonce: string): Promise<boolean> {
    this.ensureCleanup();
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO used_nonces (device_id, nonce, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT DO NOTHING
       RETURNING nonce`,
      [deviceId, nonce, NONCE_TTL_SECONDS],
    );
    return rows.length === 1;
  }

  /** Muddati o'tgan nonce'larni tozalaydi (birinchi ishlatishda lazy ishga tushadi). */
  async cleanupExpired(): Promise<void> {
    try {
      await this.dataSource.query(`DELETE FROM used_nonces WHERE expires_at < now()`);
    } catch (err) {
      this.logger.warn(`used_nonces cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private ensureCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), NONCE_CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}
