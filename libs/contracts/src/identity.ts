import { z } from 'zod';

/**
 * Identity kontrakti (0.6): enrollment, imzolangan so'rovlar, klient tokenlari, audit.
 * Center, agentd va klientlar shu fayldan import qiladi. Hech qaysi sir (kod, token, imzo)
 * audit yozuviga tushmaydi.
 */

// --- Imzolangan so'rovlar (agentd -> center, HTTP) -----------------------------------------

/** Imzolangan so'rov sarlavhalari (Node kichik harfga o'tkazadi). */
export const SIGNED_HEADERS = {
  deviceId: 'x-device-id',
  timestamp: 'x-timestamp',
  nonce: 'x-nonce',
  signature: 'x-signature',
} as const;

export const SIGNATURE_VERSION = 'COMMANDER-SIG-V1';
/** |center_now - X-Timestamp| shu qiymatdan oshsa so'rov rad etiladi. */
export const SIGNATURE_MAX_SKEW_SECONDS = 60;

/** X-Timestamp: epoch millisekund, o'nlik butun son (matn). */
export const SignedTimestampSchema = z.string().regex(/^\d{10,16}$/);
/** X-Nonce: har so'rovga yangi tasodifiy qiymat (kamida 128 bit tavsiya: 22+ belgi base64url). */
export const SignedNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** X-Signature: Ed25519 imzosi (64 bayt), base64url (paddingsiz). */
export const SignatureValueSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

/**
 * Query'ni kanoniklashtirish: xom (decode qilinmagan) query satri `&` bo'yicha bo'linadi,
 * bo'sh bo'laklar tashlanadi, bo'laklar (kod birligi bo'yicha) saralanadi va `&` bilan
 * birlashtiriladi. `?` belgisi kiritilmaydi.
 */
export function canonicalQuery(rawQuery: string): string {
  return rawQuery
    .split('&')
    .filter((part) => part.length > 0)
    .sort()
    .join('&');
}

export interface CanonicalRequestParts {
  method: string;
  /** Xom yo'l (decode qilinmagan, `?` gacha), masalan `/v1/devices/me`. */
  path: string;
  /** Xom query satri (`?`siz), bo'lmasa bo'sh. */
  rawQuery: string;
  /** Tananing SHA-256 xeshi, kichik harfli hex (64). Tana yo'q bo'lsa bo'sh tananing xeshi. */
  bodySha256: string;
  timestamp: string;
  nonce: string;
  deviceId: string;
}

/**
 * Imzolanadigan kanonik satr (UTF-8, qatorlar `\n` bilan, oxirida `\n` yo'q):
 *
 *   COMMANDER-SIG-V1
 *   <METHOD katta harf>
 *   <path>
 *   <canonicalQuery>
 *   <sha256(body) hex>
 *   <timestamp ms>
 *   <nonce>
 *   <device_id>
 */
export function buildCanonicalString(p: CanonicalRequestParts): string {
  return [
    SIGNATURE_VERSION,
    p.method.toUpperCase(),
    p.path,
    canonicalQuery(p.rawQuery),
    p.bodySha256.toLowerCase(),
    p.timestamp,
    p.nonce,
    p.deviceId,
  ].join('\n');
}

// --- Enrollment ----------------------------------------------------------------------------

/**
 * Bir martalik kod: Crockford base32 (0-9, A-Z, I L O U siz), 8 belgi (40 bit),
 * `XXXX-XXXX` ko'rinishida beriladi; kiritishda registr, `-` va bo'shliq e'tiborsiz.
 */
export const EnrollmentCodeSchema = z.string().min(8).max(24).regex(/^[0-9A-Za-z -]+$/);

/**
 * Ed25519 public key: XOM 32 bayt, base64url (43 belgi) yoki standart base64 (44 belgi, `=`).
 * SPKI/PEM QABUL QILINMAYDI (format chalkashligi). Node'da: `publicKey.export({format:'jwk'}).x`.
 */
export const RawEd25519PublicKeySchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/, 'public_key must be raw 32-byte Ed25519 key in base64/base64url');

export const EnrollRequestSchema = z
  .object({
    code: EnrollmentCodeSchema,
    public_key: RawEd25519PublicKeySchema,
    /** Barqaror apparat identifikatori (tavsiya: sha256(IOPlatformUUID | /etc/machine-id) hex). */
    hardware_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    hostname: z.string().min(1).max(255),
    os: z.string().min(1).max(64),
    arch: z.string().min(1).max(32),
  })
  .strict();
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  device_id: z.uuid(),
  machine_id: z.uuid(),
  /** Markaz buyruq-imzo kalitining public qismi (xom 32 bayt, base64url): agentd enrollment paytida PIN qiladi (TOFU emas). */
  center_public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

export const DeviceMeResponseSchema = z.object({
  device_id: z.uuid(),
  machine_id: z.uuid().nullable(),
  kind: z.string(),
  name: z.string().nullable(),
  server_time: z.string(),
});
export type DeviceMeResponse = z.infer<typeof DeviceMeResponseSchema>;

// --- Klient tokenlari ----------------------------------------------------------------------

/**
 * Scope'lar tekis (ierarxiyasiz), faqat `admin` hammasini qamrab oladi:
 *  - read    : o'qish (sessiyalar, usage, limitlar, mashinalar)
 *  - approve : permission so'rovlarini approve/deny
 *  - control : buyruq yuborish (prompt, start, stop). Step-up Faza 1'da
 *  - admin   : audit o'qish, qurilma/token boshqaruvi (HTTP'da hozircha faqat GET /v1/audit)
 */
export const CLIENT_TOKEN_SCOPES = ['read', 'approve', 'control', 'admin'] as const;
export const ClientTokenScopeSchema = z.enum(CLIENT_TOKEN_SCOPES);
export type ClientTokenScope = z.infer<typeof ClientTokenScopeSchema>;

export const CLIENT_DEVICE_KINDS = ['web', 'menubar', 'mobile', 'telegram'] as const;
export const ClientDeviceKindSchema = z.enum(CLIENT_DEVICE_KINDS);
export type ClientDeviceKind = z.infer<typeof ClientDeviceKindSchema>;

/** Token ko'rinishi: `cmdr_` + base64url(32 tasodifiy bayt). Faqat SHA-256 xeshi saqlanadi. */
export const CLIENT_TOKEN_PREFIX = 'cmdr_';

// --- Klient pairing (menu-bar, mobil): bir martalik kod -> klient tokeni ---------------------

/** CLI orqali beriladigan klient turlari (web/telegram boshqa yo'llar bilan beriladi). */
export const CLIENT_PAIRING_KINDS = ['menubar', 'mobile'] as const;
export const ClientPairingKindSchema = z.enum(CLIENT_PAIRING_KINDS);
export type ClientPairingKind = z.infer<typeof ClientPairingKindSchema>;

/** Pairing orqali berilishi mumkin bo'lgan scope'lar (`admin` HECH QACHON: faqat CLI token). */
export const PAIRING_SCOPES = ['read', 'approve', 'control'] as const;

/** Pairing kodi: Crockford base32, 10 belgi (50 bit), `XXXXX-XXXXX` ko'rinishida. Enrollment kodidan alohida jadval. */
export const CLIENT_PAIRING_CODE_LENGTH = 10;
export const CLIENT_PAIRING_DEFAULT_TTL_MINUTES = 10;
export const CLIENT_PAIRING_MAX_TTL_MINUTES = 60;
/** Pairing orqali berilgan token muddati (kun): PLAN 9 "90 kunlik". */
export const CLIENT_PAIRING_TOKEN_DAYS = 90;

/** `POST /v1/clients/pair` (autentifikatsiyasiz, rate-limit). `platform`: `macos` | `ios` | `android` | ... */
export const ClientPairBodySchema = z
  .object({
    code: EnrollmentCodeSchema,
    deviceName: z.string().trim().min(1).max(100),
    platform: z.string().trim().min(1).max(32),
    /** Ixtiyoriy: xom 32 bayt Ed25519 (kelajakdagi imzolangan so'rovlar uchun; hozir faqat saqlanadi). */
    publicKey: RawEd25519PublicKeySchema.optional(),
  })
  .strict();
export type ClientPairBody = z.infer<typeof ClientPairBodySchema>;

/** Token FAQAT shu javobda ko'rinadi (DB'da xesh). */
export const ClientPairResponseSchema = z.object({
  token: z.string(),
  deviceId: z.uuid(),
  kind: ClientDeviceKindSchema,
  name: z.string(),
  scopes: z.array(ClientTokenScopeSchema),
  expiresAt: z.string().nullable(),
  serverTime: z.string(),
});
export type ClientPairResponse = z.infer<typeof ClientPairResponseSchema>;

/** `GET /v1/devices/me` (klient tokeni bilan): qurilma va scope'lar. */
export const ClientDeviceMeResponseSchema = z.object({
  deviceId: z.uuid(),
  kind: ClientDeviceKindSchema,
  name: z.string().nullable(),
  platform: z.string().nullable(),
  scopes: z.array(ClientTokenScopeSchema),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** Step-up istisnosi ro'yxatida (egasi qo'shgan bo'lsa). Odatda false. */
  stepUpExempt: z.boolean(),
  serverTime: z.string(),
});
export type ClientDeviceMeResponse = z.infer<typeof ClientDeviceMeResponseSchema>;

/** `POST /v1/devices/me/revoke`: klient o'zini unpair qiladi (token darhol yaroqsiz). */
export const ClientRevokeResponseSchema = z.object({ revoked: z.literal(true), deviceId: z.uuid() });
export type ClientRevokeResponse = z.infer<typeof ClientRevokeResponseSchema>;

/** QR / deep-link: `commander://pair?c=<center https url>&code=<code>[&fp=<fingerprint>]`. */
export const PAIRING_URL_SCHEME = 'commander:';

export function buildPairingUrl(p: { centerUrl: string; code: string; fingerprint?: string }): string {
  const q = new URLSearchParams({ c: p.centerUrl, code: p.code });
  if (p.fingerprint) q.set('fp', p.fingerprint);
  return `commander://pair?${q.toString()}`;
}

export interface ParsedPairingUrl {
  centerUrl: string;
  code: string;
  fingerprint: string | null;
}

/** Noto'g'ri URL uchun null (klient: "QR noto'g'ri"). Center manzili faqat `https:` (yoki `http://127.0.0.1` dev). */
export function parsePairingUrl(raw: string): ParsedPairingUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== PAIRING_URL_SCHEME || u.hostname !== 'pair') return null;
  const c = u.searchParams.get('c');
  const code = u.searchParams.get('code');
  if (!c || !code) return null;
  let center: URL;
  try {
    center = new URL(c);
  } catch {
    return null;
  }
  const devLoopback = center.protocol === 'http:' && (center.hostname === '127.0.0.1' || center.hostname === 'localhost');
  if (center.protocol !== 'https:' && !devLoopback) return null;
  return { centerUrl: center.origin, code, fingerprint: u.searchParams.get('fp') };
}

// --- Audit ---------------------------------------------------------------------------------

export const AUDIT_ACTOR_KINDS = ['agentd', 'web', 'menubar', 'mobile', 'telegram', 'system'] as const;

export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor_device_id: z.uuid().nullable(),
  actor_kind: z.enum(AUDIT_ACTOR_KINDS),
  action: z.string(),
  target: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  prev_hash: z.string().nullable(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const ListAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Kursor: shu id'dan KICHIK yozuvlar (yangidan eskiga). */
    before: z.string().regex(/^\d{1,18}$/).optional(),
    action: z.string().min(1).max(100).optional(),
    /** `verify=1`: ro'yxat o'rniga zanjir tekshiruvi natijasi. */
    verify: z.enum(['1', 'true']).optional(),
  })
  .strict();
export type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;

export const ListAuditResponseSchema = z.object({
  items: z.array(AuditEntrySchema),
  next_before: z.string().nullable(),
});
export type ListAuditResponse = z.infer<typeof ListAuditResponseSchema>;

export const AuditVerifyResponseSchema = z.object({
  ok: z.boolean(),
  /** Zanjir buzilgan birinchi qator id'si (ok=true bo'lsa null). */
  first_broken_id: z.string().nullable(),
  checked_rows: z.string(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>;
