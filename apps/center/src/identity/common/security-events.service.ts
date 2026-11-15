import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import { FailureAggregator } from '../audit/failure-aggregator.js';
import { createHash } from 'node:crypto';
import { clientKey, requestIp, socketIp } from './request-context.js';
import { FixedWindowLimiter } from './rate-limiter.js';
import type { Principal } from './request-context.js';

/** M-08: har mijoz (tailnet IP) uchun alohida chelak; bitta buzilgan qurilma boshqalarni to'sa olmaydi. */
export const AUTH_FAIL_LIMIT = 60;
/** Yaqinda muvaffaqiyatli o'tgan hisob (qurilma id / token xeshi): to'fonda ham tekshiriladi (qulf yo'q). */
export const RECENT_VALID_TTL_MS = 10 * 60_000;
const RECENT_VALID_MAX = 2048;
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const ENROLL_REQUEST_LIMIT = 30;
export const ENROLL_REQUEST_WINDOW_MS = 60_000;
export const ENROLL_FAIL_IP_LIMIT = 5;
export const ENROLL_FAIL_GLOBAL_LIMIT = 10;
export const ENROLL_FAIL_WINDOW_MS = 10 * 60_000;

export const PAIR_REQUEST_LIMIT = 30;
export const PAIR_REQUEST_WINDOW_MS = 60_000;
export const PAIR_FAIL_IP_LIMIT = 5;
export const PAIR_FAIL_GLOBAL_LIMIT = 10;
export const PAIR_FAIL_WINDOW_MS = 10 * 60_000;

export const tooMany = (retryAfterSeconds: number): HttpException =>
  new HttpException(
    { error: 'rate_limited', message: 'Too many attempts, retry later', retry_after_seconds: retryAfterSeconds },
    HttpStatus.TOO_MANY_REQUESTS,
  );

/**
 * Xavfsizlik hodisalari uchun yagona joy: rate-limit (xotirada) va audit (aggregatsiyalangan).
 *
 * M-08: auth-failure limiteri MIJOZ bo'yicha (`clientKey`: tailscale serve XFF'ining ishonchli oxirgi qiymati), umumiy chelak emas.
 * Qulf faqat NOTO'G'RI hisob ma'lumotlari uchun: yaqinda muvaffaqiyatli o'tgan token/qurilma (`markValid`) to'fon ostida ham
 * har doim tekshiriladi, shu sabab bitta buzilgan tailnet qurilmasi dashboard/mobil/agentd'ni to'sa olmaydi. Tokenlar 256 bit:
 * limit brute-force emas, resurs (DB qidiruv) himoyasi.
 */
@Injectable()
export class SecurityEvents {
  readonly authFailures = new FixedWindowLimiter(AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS);
  readonly enrollRequests = new FixedWindowLimiter(ENROLL_REQUEST_LIMIT, ENROLL_REQUEST_WINDOW_MS);
  readonly enrollFailuresByIp = new FixedWindowLimiter(ENROLL_FAIL_IP_LIMIT, ENROLL_FAIL_WINDOW_MS);
  readonly enrollFailuresGlobal = new FixedWindowLimiter(ENROLL_FAIL_GLOBAL_LIMIT, ENROLL_FAIL_WINDOW_MS);

  readonly pairRequests = new FixedWindowLimiter(PAIR_REQUEST_LIMIT, PAIR_REQUEST_WINDOW_MS);
  readonly pairFailuresByIp = new FixedWindowLimiter(PAIR_FAIL_IP_LIMIT, PAIR_FAIL_WINDOW_MS);
  readonly pairFailuresGlobal = new FixedWindowLimiter(PAIR_FAIL_GLOBAL_LIMIT, PAIR_FAIL_WINDOW_MS);

  private readonly recentValid = new Map<string, number>();

  constructor(private readonly aggregator: FailureAggregator) {}

  /** Hisob ma'lumoti identifikatori (maxfiy emas): Bearer -> `t:<sha256 prefiksi>`, qurilma -> `d:<id>`. */
  static bearerId(bearer: string): string {
    return `t:${createHash('sha256').update(bearer, 'utf8').digest('hex').slice(0, 24)}`;
  }

  markValid(id: string, now: number = Date.now()): void {
    if (this.recentValid.size >= RECENT_VALID_MAX) {
      for (const [k, exp] of this.recentValid) if (exp <= now) this.recentValid.delete(k);
      if (this.recentValid.size >= RECENT_VALID_MAX) this.recentValid.delete(this.recentValid.keys().next().value as string);
    }
    this.recentValid.delete(id);
    this.recentValid.set(id, now + RECENT_VALID_TTL_MS);
  }

  isRecentlyValid(id: string | undefined, now: number = Date.now()): boolean {
    if (!id) return false;
    const exp = this.recentValid.get(id);
    return exp !== undefined && exp > now;
  }

  /** Auth xatolari to'fonida DB'ga yetmasdan 429 (faqat shu mijoz va faqat yaqinda ko'rilmagan hisob ma'lumoti uchun). */
  assertAuthNotFlooded(req: Request, credentialId?: string): void {
    const key = clientKey(req);
    if (this.authFailures.isBlocked(key) && !this.isRecentlyValid(credentialId)) throw tooMany(this.authFailures.retryAfterSeconds(key));
  }

  authFailed(req: Request, info: { scheme: 'signature' | 'bearer'; reason: string; claimedDeviceId?: string }): void {
    this.authFailures.hit(clientKey(req));
    const ip = requestIp(req);
    this.aggregator.note(`auth|${info.scheme}|${info.reason}|${ip ?? socketIp(req)}`, {
      actorKind: 'system',
      action: 'auth.failed',
      ip,
      details: {
        scheme: info.scheme,
        reason: info.reason,
        method: req.method,
        path: (req.originalUrl.split('?')[0] ?? '').slice(0, 200),
        ...(info.claimedDeviceId ? { claimed_device_id: info.claimedDeviceId } : {}),
      },
    });
  }

  /** WS handshake (agentd) ulanish bosqichi: auth urinishlari to'fonida challenge yuborilmaydi. */
  isWsAuthFlooded(req: IncomingMessage): boolean {
    return this.authFailures.isBlocked(clientKey(req));
  }

  /** WS challenge-response muvaffaqiyatsizligi (`reason`: unauthorized | device_revoked | stale_timestamp | bad_request | timeout). */
  wsAuthFailed(req: IncomingMessage, info: { reason: string; claimedDeviceId?: string }): void {
    this.authFailures.hit(clientKey(req));
    const ip = requestIp(req);
    this.aggregator.note(`auth|ws|${info.reason}|${ip ?? socketIp(req)}`, {
      actorKind: 'system',
      action: 'auth.failed',
      ip,
      details: {
        scheme: 'ws-challenge',
        reason: info.reason,
        path: '/ws/agent',
        ...(info.claimedDeviceId ? { claimed_device_id: info.claimedDeviceId } : {}),
      },
    });
  }

  /** `/ws/client` auth muvaffaqiyatsizligi (Bearer klient tokeni: subprotocol yoki birinchi xabar). Token logga/auditga tushmaydi. */
  clientWsAuthFailed(req: IncomingMessage, info: { reason: string; claimedDeviceId?: string }): void {
    this.authFailures.hit(clientKey(req));
    const ip = requestIp(req);
    this.aggregator.note(`auth|ws-client|${info.reason}|${ip ?? socketIp(req)}`, {
      actorKind: 'system',
      action: 'auth.failed',
      ip,
      details: {
        scheme: 'ws-bearer',
        reason: info.reason,
        path: '/ws/client',
        ...(info.claimedDeviceId ? { claimed_device_id: info.claimedDeviceId } : {}),
      },
    });
  }

  /** agentd ulandi/uzildi (aggregatsiya: har kalit uchun oynada bitta qator, telemetriya xabarlari audit qilinmaydi). */
  agentPresence(
    req: IncomingMessage | null,
    info: { action: 'agent.connected' | 'agent.disconnected'; deviceId: string; machineId: string; details?: Record<string, unknown> },
  ): void {
    const ip = req ? requestIp(req) : null;
    this.aggregator.note(`${info.action}|${info.deviceId}`, {
      actorDeviceId: info.deviceId,
      actorKind: 'agentd',
      action: info.action,
      target: info.machineId,
      ip,
      details: info.details ?? {},
    });
  }

  lockdownRejected(req: Request, principal: Principal): void {
    this.aggregator.note(`lockdown|${principal.device.id}`, {
      actorDeviceId: principal.device.id,
      actorKind: principal.actorKind,
      action: 'lockdown.rejected',
      ip: requestIp(req),
      details: { method: req.method, path: (req.originalUrl.split('?')[0] ?? '').slice(0, 200) },
    });
  }

  enrollFailed(req: Request, reason: string, codeId?: string): void {
    const ip = requestIp(req);
    this.aggregator.note(`enroll|${reason}|${ip ?? socketIp(req)}`, {
      actorKind: 'system',
      action: 'enrollment_code.failed',
      target: codeId ?? null,
      ip,
      details: { reason },
    });
  }

  pairFailed(req: Request, reason: string, codeId?: string): void {
    const ip = requestIp(req);
    this.aggregator.note(`pair|${reason}|${ip ?? socketIp(req)}`, {
      actorKind: 'system',
      action: 'pairing_code.failed',
      target: codeId ?? null,
      ip,
      details: { reason },
    });
  }
}
