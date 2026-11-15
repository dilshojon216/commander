import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { ClientDeviceKind, ClientTokenScope } from '@commander/contracts';
import type { Device } from '../../database/entities/device.entity.js';

export type Principal =
  | { type: 'device'; actorKind: 'agentd'; device: Device }
  | { type: 'client'; actorKind: ClientDeviceKind; device: Device; scopes: ClientTokenScope[] };

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
    /** json body-parser `verify` hook to'ldiradi (imzo uchun xom tana). */
    rawBody?: Buffer;
  }
}

/** IP olish uchun kerakli minimum: express `Request` ham, WS handshake `IncomingMessage` ham mos. */
export type IpSource = Pick<IncomingMessage, 'socket' | 'headers'>;

const stripV4Mapped = (ip: string): string => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/** TCP peer manzili (rate-limit kaliti). Proksi ortida hamma tailnet trafigi bitta peer bo'lib ko'rinadi. */
export function socketIp(req: IpSource): string {
  return stripV4Mapped(req.socket.remoteAddress ?? 'unknown');
}

function isLocalOrPrivate(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^f[cd]/i.test(ip); // fc00::/7
}

/**
 * Mijoz IP'si (audit va auth-failure limiter kaliti). `X-Forwarded-For` FAQAT peer loopback/private bo'lganda
 * (tailscale serve va Docker bridge) hisobga olinadi, va OXIRGI qiymat olinadi: uni ishonchli proksi qo'shgan, birinchisini
 * esa mijozning o'zi yozgan bo'lishi mumkin (soxtalashtirish, L-23/M-08). Boshqa hollarda peer manzili.
 * Auth qarori uchun ISHLATILMAYDI; faqat "kim to'fon qilmoqda" aniqlash va audit.
 */
export function requestIp(req: IpSource): string | null {
  const peer = socketIp(req);
  if (isLocalOrPrivate(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const parts = (Array.isArray(xff) ? xff.join(',') : xff)?.split(',') ?? [];
    const last = parts[parts.length - 1]?.trim();
    if (last && isIP(stripV4Mapped(last))) return stripV4Mapped(last);
  }
  return isIP(peer) ? peer : null;
}

/** Rate-limit kaliti: haqiqiy tailnet mijozi (ishonchli XFF) yoki peer. Hech qachon bo'sh emas. */
export function clientKey(req: IpSource): string {
  return requestIp(req) ?? socketIp(req);
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1]?.trim() || null;
}

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isMutating = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());
