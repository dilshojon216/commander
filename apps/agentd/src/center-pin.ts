import { createHash, createPublicKey, verify } from 'node:crypto';
import { buildCenterKeyRotationString } from '@commander/contracts';
import type { CenterKeyRotation } from '@commander/contracts';
import type { AgentdConfig } from './config.js';

// SPKI prefiksi Ed25519 uchun (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** `sha256(xom public key)` birinchi 16 hex: markazdagi `center-key show` bilan qo'lda solishtirish uchun. */
export function fingerprintOf(publicKeyRaw: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyRaw, 'base64url')).digest('hex').slice(0, 16);
}

export type PinDecision =
  /** Pin yo'q, markaz kalit e'lon qildi: birinchi ko'rilgan kalitni pin qil (TOFU). */
  | { kind: 'pin'; publicKey: string }
  | { kind: 'match' }
  /** Pin bor, markaz boshqa kalit e'lon qildi: buyruqlar rad etiladi (lokal `center-key reset` kerak). */
  | { kind: 'mismatch' }
  /** Markaz kalit e'lon qilmadi (eski center): pin bo'lsa o'zgarmaydi, bo'lmasa buyruqlar rad etiladi. */
  | { kind: 'none' };

export function decidePin(pinned: AgentdConfig['centerKey'], announced: string | undefined): PinDecision {
  if (!announced) return { kind: 'none' };
  if (!pinned) return { kind: 'pin', publicKey: announced };
  return pinned.publicKey === announced ? { kind: 'match' } : { kind: 'mismatch' };
}

/**
 * Markaz kalitini aylantirish e'lonlarini qo'llaydi (5.1). Har e'lon: `previousPublicKey` joriy pin bo'lishi, muddati o'tmagan
 * bo'lishi va imzo ESKI (pin qilingan) kalit bilan to'g'ri bo'lishi shart; shundagina pin YANGI kalitga o'tadi (TOFUsiz).
 * Zanjir ketma-ket qo'llanadi; birinchi yaroqsiz e'londa to'xtaydi (pin o'zgarmay qoladi: fail-safe).
 */
export function applyCenterKeyRotations(
  pinned: AgentdConfig['centerKey'],
  rotations: readonly CenterKeyRotation[],
  now: number,
): { pinned: AgentdConfig['centerKey']; applied: number; rejected: string | null } {
  let current = pinned;
  let applied = 0;
  for (const r of rotations) {
    if (!current) return { pinned: current, applied, rejected: "pin yo'q: e'lon qabul qilinmaydi (TOFU kerak)" };
    if (current.publicKey !== r.previousPublicKey) return { pinned: current, applied, rejected: "e'lon pin qilingan kalitga bog'lanmagan" };
    if (r.expiresAt <= now) return { pinned: current, applied, rejected: "e'lon muddati tugagan: qo'lda `agentd center-key reset` kerak" };
    if (!verifyRotationSignature(r)) return { pinned: current, applied, rejected: "e'lon imzosi noto'g'ri" };
    current = { publicKey: r.newPublicKey, fingerprint: fingerprintOf(r.newPublicKey), pinnedAt: new Date(now).toISOString(), via: 'rotation' };
    applied += 1;
  }
  return { pinned: current, applied, rejected: null };
}

export function verifyRotationSignature(r: CenterKeyRotation): boolean {
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(r.previousPublicKey, 'base64url')]);
    return verify(null, Buffer.from(buildCenterKeyRotationString(r), 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(r.signature, 'base64url'));
  } catch {
    return false;
  }
}
