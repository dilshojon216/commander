import { z } from 'zod';
import { EpochMsSchema, envelopeMessage } from './envelope.js';

/**
 * Kalit aylantirish kontrakti (5.1).
 *
 * 1) Qurilma kaliti (agentd): `key.rotate` autentifikatsiyalangan `/ws/agent` ustida. Agent HAM eski, HAM yangi
 *    kalit bilan bir xil kanonik satrni imzolaydi (egalik isboti ikkala kalitga). Center eski kalitni atomik
 *    almashtiradi, audit yozadi; eski kalit shundan keyin rad etiladi.
 * 2) Markaz buyruq-imzo kaliti: `center-key rotate` eski kalit bilan YANGI kalitni imzolaydi (e'lon). agentd
 *    pin qilingan eski kalit bilan imzoni tekshiradi va pin'ni TOFUsiz yangilaydi.
 */

const Base64UrlRawKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Base64UrlSignature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

// --- Qurilma kalitini aylantirish ------------------------------------------------------------

export const KEY_ROTATION_STRING_VERSION = 'COMMANDER-KEY-ROTATE-V1';
/** `ts` va center soati farqi (ms) shundan oshsa so'rov rad etiladi. */
export const KEY_ROTATION_MAX_SKEW_MS = 60_000;

export interface KeyRotationStringParts {
  deviceId: string;
  /** Hozirgi (eski) public key, xom 32 bayt base64url. */
  oldPublicKey: string;
  newPublicKey: string;
  /** Agent soati, epoch ms. */
  ts: number;
}

/**
 * Ikkala kalit imzolaydigan kanonik satr (UTF-8, `\n`, oxirida `\n` yo'q):
 *   COMMANDER-KEY-ROTATE-V1 / deviceId (kichik harf) / oldPublicKey / newPublicKey / ts
 * Imzo: Ed25519, base64url. Imzo eski kalitga bog'langan, shuning uchun yangi kalitdan keyin takrorlab bo'lmaydi.
 */
export function buildKeyRotationString(p: KeyRotationStringParts): string {
  return [KEY_ROTATION_STRING_VERSION, p.deviceId.toLowerCase(), p.oldPublicKey, p.newPublicKey, String(p.ts)].join('\n');
}

export const KeyRotatePayloadSchema = z.object({
  newPublicKey: Base64UrlRawKey,
  ts: EpochMsSchema,
  /** Eski kalit imzosi (hozirgi kalit egaligi). */
  oldSignature: Base64UrlSignature,
  /** Yangi kalit imzosi (yangi kalit egaligi). */
  newSignature: Base64UrlSignature,
});
export type KeyRotatePayload = z.infer<typeof KeyRotatePayloadSchema>;
/** Agent -> center. Ack'siz (jonli): javob `key.rotate.result`, bog'lash `envelope.id` bo'yicha (`result.requestId`). */
export const KeyRotateMessageSchema = envelopeMessage('key.rotate', KeyRotatePayloadSchema);

export const KEY_ROTATE_ERROR_CODES = ['invalid_signature', 'stale_timestamp', 'same_key', 'key_in_use', 'conflict', 'rate_limited', 'revoked'] as const;
export const KeyRotateResultPayloadSchema = z.object({
  /** `key.rotate` envelope id'si. */
  requestId: z.uuid(),
  ok: z.boolean(),
  code: z.enum(KEY_ROTATE_ERROR_CODES).optional(),
});
export type KeyRotateResultPayload = z.infer<typeof KeyRotateResultPayloadSchema>;
export const KeyRotateResultMessageSchema = envelopeMessage('key.rotate.result', KeyRotateResultPayloadSchema);

/** Center -> agent: "kalitni aylantiring" (markaz tashabbusi). agentd o'zi `key.rotate` yuboradi. */
export const KeyRotationRequiredMessageSchema = envelopeMessage('key.rotation_required', z.object({}));

// --- Markaz imzo kalitini aylantirish ---------------------------------------------------------

export const CENTER_KEY_ROTATION_STRING_VERSION = 'COMMANDER-CENTER-KEY-ROTATION-V1';
/** `center-key rotate` ning standart ustma-ust tushish oynasi (kun). */
export const CENTER_KEY_OVERLAP_DAYS_DEFAULT = 30;

export interface CenterKeyRotationStringParts {
  previousPublicKey: string;
  newPublicKey: string;
  issuedAt: number;
  expiresAt: number;
}

/** Eski markaz kaliti imzolaydigan satr: COMMANDER-CENTER-KEY-ROTATION-V1 / old / new / issuedAt / expiresAt. */
export function buildCenterKeyRotationString(p: CenterKeyRotationStringParts): string {
  return [CENTER_KEY_ROTATION_STRING_VERSION, p.previousPublicKey, p.newPublicKey, String(p.issuedAt), String(p.expiresAt)].join('\n');
}

export const CenterKeyRotationSchema = z.object({
  previousPublicKey: Base64UrlRawKey,
  newPublicKey: Base64UrlRawKey,
  issuedAt: EpochMsSchema,
  /** Ustma-ust tushish oynasi tugashi: shundan keyin agentd e'lonni qabul qilmaydi (qo'lda `center-key reset`). */
  expiresAt: EpochMsSchema,
  /** ESKI markaz kalitining imzosi. */
  signature: Base64UrlSignature,
});
export type CenterKeyRotation = z.infer<typeof CenterKeyRotationSchema>;

/** Markaz kaliti fingerprint'i (`sha256(xom kalit)` birinchi 16 hex): agent `auth.response`da pin'ini bildiradi. */
export const CenterKeyFingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);
