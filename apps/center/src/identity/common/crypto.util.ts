import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { CLIENT_PAIRING_CODE_LENGTH, CLIENT_TOKEN_PREFIX } from '@commander/contracts';

export const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Constant-time compare of two equal-purpose strings (digests first, so length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

// Crockford base32 (I, L, O, U yo'q): 32 belgi = 5 bit/belgi.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROLLMENT_CODE_LENGTH = 8;

/** `XXXX-XXXX` (40 bit entropiya, CSPRNG, bir tekis taqsimot). */
export function generateEnrollmentCode(): string {
  let out = '';
  for (let i = 0; i < ENROLLMENT_CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Pairing kodi `XXXXX-XXXXX` (50 bit, CSPRNG). Normallashtirish/xeshlash enrollment bilan bir xil. */
export function generatePairingCode(): string {
  let out = '';
  for (let i = 0; i < CLIENT_PAIRING_CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const half = CLIENT_PAIRING_CODE_LENGTH / 2;
  return `${out.slice(0, half)}-${out.slice(half)}`;
}

/** Registr, `-`/bo'shliq e'tiborsiz; Crockford: O->0, I/L->1. Natija xeshlanadigan kanonik shakl. */
export function normalizeEnrollmentCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export const hashEnrollmentCode = (raw: string): string => sha256Hex(normalizeEnrollmentCode(raw));

/** `cmdr_` + base64url(32 bayt). */
export function generateClientToken(): string {
  return CLIENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Xom Ed25519 public key (32 bayt) base64/base64url'dan. Faqat kanonik kodlash qabul qilinadi
 * (oxirgi bitlar nol), SPKI/PEM uzunligi (44 bayt) rad etiladi. Noto'g'ri bo'lsa null.
 */
export function decodeRawEd25519PublicKey(value: string): Buffer | null {
  const urlSafe = value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const raw = Buffer.from(urlSafe, 'base64url');
  if (raw.length !== 32) return null;
  if (raw.toString('base64url') !== urlSafe) return null;
  if (raw.every((b) => b === 0)) return null;
  return raw;
}

// SubjectPublicKeyInfo prefiksi Ed25519 uchun (RFC 8410): 302a300506032b6570032100 || key
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}
