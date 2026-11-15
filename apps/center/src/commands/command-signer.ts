import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCommandSigString, canonicalJson } from '@commander/contracts';
import type { CommandSigParts } from '@commander/contracts';
import { recoverRotations } from './center-key-rotation.js';

/** `sha256(canonicalJson(payload))` (hex): imzo xeshi ikki tomonda bir xil hisoblanadi. */
export function hashCommandPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export function newDispatchNonce(): string {
  return randomBytes(32).toString('base64url');
}

export interface SignerKeys {
  privateKey: KeyObject;
  /** Xom 32 bayt Ed25519 public key, base64url (43 belgi). */
  publicKeyRaw: string;
  /** Qisqa belgi (sha256(raw pub) birinchi 16 hex): logda/CLI'da tekshirish uchun; sir emas. */
  fingerprint: string;
}

function toKeys(privateKey: KeyObject): SignerKeys {
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Ed25519 public key JWK export failed');
  return { privateKey, publicKeyRaw: x, fingerprint: createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 16) };
}

/**
 * Markaz imzo kalitini fayldan yuklaydi; yo'q bo'lsa yaratadi (dir 0700, fayl 0600, PKCS8 PEM). Kalit DB'da emas,
 * konteynerning maxfiy volume'ida. `file === null` = faqat xotirada (testlar). Maxfiy kalit hech qachon logga chiqmaydi.
 * Fayl guruh/boshqalarga ochiq bo'lsa (POSIX) yuklashdan bosh tortiladi.
 */
export function loadOrCreateSignerKeys(file: string | null): SignerKeys {
  if (file === null) return toKeys(generateKeyPairSync('ed25519').privateKey);
  if (existsSync(file)) {
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
      throw new Error(`center signing key ${file} must not be accessible by group/others (chmod 600)`);
    }
    const keys = toKeys(createPrivateKey({ key: readFileSync(file), format: 'pem', type: 'pkcs8' }));
    recoverRotations(file, keys.publicKeyRaw); // `center-key rotate` yarim qolgan bo'lsa (5.1)
    return keys;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  chmodSync(file, 0o600);
  return toKeys(privateKey);
}

/** `command.dispatch` imzosi: Ed25519 `buildCommandSigString(...)` ustida, base64url. */
export function signCommand(privateKey: KeyObject, parts: CommandSigParts): string {
  return sign(null, Buffer.from(buildCommandSigString(parts), 'utf8'), privateKey).toString('base64url');
}
