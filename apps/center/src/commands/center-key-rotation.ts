import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CENTER_KEY_OVERLAP_DAYS_DEFAULT, CenterKeyRotationSchema, buildCenterKeyRotationString } from '@commander/contracts';
import type { CenterKeyRotation } from '@commander/contracts';
import { ed25519PublicKeyFromRaw } from '../identity/common/crypto.util.js';

/**
 * Markaz imzo kalitini aylantirish (5.1). Eski maxfiy kalit aylantirish paytida faqat BIR marta ishlatiladi (yangi kalitni
 * imzolash uchun) va darhol almashtiriladi: ustma-ust tushish oynasi uchun maxfiy kalit saqlanmaydi, faqat tayyor imzolangan
 * e'lon (`<keyFile>.rotations.json`, ochiq ma'lumot) saqlanadi.
 */

export const rotationsFileOf = (keyFile: string): string => `${keyFile}.rotations.json`;

export const fingerprintOfRaw = (rawBase64Url: string): string => createHash('sha256').update(Buffer.from(rawBase64Url, 'base64url')).digest('hex').slice(0, 16);

const rawPublic = (key: KeyObject): string => {
  const x = createPublicKey(key).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Ed25519 public key JWK export failed');
  return x;
};

function writeSecret(file: string, content: string | Buffer): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface RotateResult {
  previousFingerprint: string;
  newFingerprint: string;
  newPublicKey: string;
  rotation: CenterKeyRotation;
  expiresAt: number;
}

/** Faylga ko'rsatilgan e'lonlar (muddati o'tmaganlari). Buzuq fayl = bo'sh (log chaqiruvchida). */
export function readRotations(keyFile: string, now: number = Date.now()): CenterKeyRotation[] {
  const file = rotationsFileOf(keyFile);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const out: CenterKeyRotation[] = [];
    for (const item of parsed) {
      const r = CenterKeyRotationSchema.safeParse(item);
      if (r.success && r.data.expiresAt > now) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Yuklashdagi tiklash: aylantirish `kalit almashtirildi, e'lon yozilmadi` oralig'ida to'xtagan bo'lsa (`.tmp` qoladi),
 * e'lon faqat YANGI kalit joriy kalit bo'lsa tiklanadi; aks holda tashlanadi (noto'g'ri kalitga pin qildirmaslik uchun).
 */
export function recoverRotations(keyFile: string, currentPublicKey: string): void {
  const tmp = `${rotationsFileOf(keyFile)}.tmp`;
  if (!existsSync(tmp)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(tmp, 'utf8'));
    const last = Array.isArray(parsed) ? CenterKeyRotationSchema.safeParse(parsed[parsed.length - 1]) : null;
    if (last?.success && last.data.newPublicKey === currentPublicKey) renameSync(tmp, rotationsFileOf(keyFile));
    else unlinkSync(tmp);
  } catch {
    unlinkSync(tmp);
  }
}

/**
 * Ishonchli zanjir: oxirgi e'lon HOZIRGI kalitga olib borishi va har bir keyingi e'lon oldingisining `newPublicKey`siga
 * ulanishi shart; aks holda hech narsa e'lon qilinmaydi (fail-safe: agent noto'g'ri kalitni pin qilmaydi).
 */
export function validChain(rotations: readonly CenterKeyRotation[], currentPublicKey: string): CenterKeyRotation[] {
  if (rotations.length === 0) return [];
  const last = rotations[rotations.length - 1]!;
  if (last.newPublicKey !== currentPublicKey) return [];
  // Eng uzun to'g'ri ulangan oxirgi zanjir.
  let start = rotations.length - 1;
  while (start > 0 && rotations[start - 1]!.newPublicKey === rotations[start]!.previousPublicKey) start -= 1;
  return rotations.slice(start);
}

/** Agentning pin fingerprint'idan boshlab e'lonlar (bo'sh = hech narsa yuborilmaydi). */
export function rotationsFrom(chain: readonly CenterKeyRotation[], pinnedFingerprint: string | undefined): CenterKeyRotation[] {
  if (!pinnedFingerprint) return [];
  const i = chain.findIndex((r) => fingerprintOfRaw(r.previousPublicKey) === pinnedFingerprint);
  return i < 0 ? [] : chain.slice(i);
}

/** E'lon imzosi `previousPublicKey` bilan tekshiriladi (agentd ham shu mantiqni ishlatadi). */
export function verifyRotation(r: CenterKeyRotation): boolean {
  try {
    const raw = Buffer.from(r.previousPublicKey, 'base64url');
    return verify(null, Buffer.from(buildCenterKeyRotationString(r), 'utf8'), ed25519PublicKeyFromRaw(raw), Buffer.from(r.signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * `center-key rotate`: yangi kalit yaratadi, ESKI kalit bilan e'lon imzolaydi, kalit faylini atomik almashtiradi.
 * Tartib (qulash xavfsiz): (1) `.rotations.json.tmp` yoziladi, (2) kalit fayli atomik almashtiriladi (`rename`),
 * (3) `.tmp` -> `.rotations.json`. (1)-(2) yoki (2)-(3) orasida to'xtasa `recoverRotations` yuklashda tuzatadi.
 */
export function rotateSignerKeyFile(keyFile: string, now: number = Date.now(), overlapDays: number = CENTER_KEY_OVERLAP_DAYS_DEFAULT): RotateResult {
  if (!Number.isInteger(overlapDays) || overlapDays < 1 || overlapDays > 365) throw new Error('overlap-days must be an integer 1-365');
  if (!existsSync(keyFile)) throw new Error(`center signing key ${keyFile} does not exist (start the center once first)`);
  const oldPrivate = createPrivateKey({ key: readFileSync(keyFile), format: 'pem', type: 'pkcs8' });
  const previousPublicKey = rawPublic(oldPrivate);
  const { privateKey: newPrivate } = generateKeyPairSync('ed25519');
  const newPublicKey = rawPublic(newPrivate);

  const issuedAt = now;
  const expiresAt = now + overlapDays * 86_400_000;
  const parts = { previousPublicKey, newPublicKey, issuedAt, expiresAt };
  const rotation: CenterKeyRotation = { ...parts, signature: sign(null, Buffer.from(buildCenterKeyRotationString(parts), 'utf8'), oldPrivate).toString('base64url') };

  const chain = [...validChain(readRotations(keyFile, now), previousPublicKey), rotation];
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmpState = `${rotationsFileOf(keyFile)}.tmp`;
  writeSecret(tmpState, JSON.stringify(chain));
  const tmpKey = `${keyFile}.new`;
  writeSecret(tmpKey, newPrivate.export({ format: 'pem', type: 'pkcs8' }));
  renameSync(tmpKey, keyFile);
  renameSync(tmpState, rotationsFileOf(keyFile));
  return { previousFingerprint: fingerprintOfRaw(previousPublicKey), newFingerprint: fingerprintOfRaw(newPublicKey), newPublicKey, rotation, expiresAt };
}
