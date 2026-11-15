import { createHash, createPublicKey, verify } from 'node:crypto';
import { buildCommandSigString, canonicalJson } from '@commander/contracts';
import type { CommandDispatchPayload, CommandErrorCode } from '@commander/contracts';

export interface VerifyContext {
  /** PIN qilingan markaz kaliti (xom 32 bayt, base64url); `undefined` = pin yo'q. */
  pinnedKey: string | undefined;
  /** Shu agentd qurilmasi: imzo shu qurilmaga bog'langan (boshqa mashina uchun imzolangan buyruq o'tmaydi). */
  deviceId: string;
  now: number;
}

export type VerifyResult = null | { code: Extract<CommandErrorCode, 'center_key_unpinned' | 'bad_signature' | 'expired' | 'invalid_payload'>; message: string };

/** Dispatch imzosi uzoq kelajakka berilgan bo'lmasligi kerak (eskirmaydigan buyruq = replay oynasi). */
export const MAX_FUTURE_EXPIRY_MS = 5 * 60_000;

export function payloadSha256(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function publicKeyFrom(raw: string) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/**
 * `command.dispatch` ni tekshiradi: pin -> imzo (Ed25519, `buildCommandSigString`) -> muddat. Imzo muddatdan OLDIN tekshiriladi.
 * Nonce bir martaligi alohida (`CommandStore.begin`, SQLite UNIQUE). `null` = yaroqli.
 */
export function verifyDispatch(msg: CommandDispatchPayload, ctx: VerifyContext): VerifyResult {
  if (!ctx.pinnedKey) return { code: 'center_key_unpinned', message: 'The center signing key is not pinned on this machine' };
  let ok = false;
  try {
    const sigString = buildCommandSigString({
      deviceId: ctx.deviceId,
      commandId: msg.commandId,
      type: msg.type,
      nonce: msg.nonce,
      expiresAt: msg.expiresAt,
      payloadSha256: payloadSha256(msg.payload),
    });
    ok = verify(null, Buffer.from(sigString, 'utf8'), publicKeyFrom(ctx.pinnedKey), Buffer.from(msg.sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { code: 'bad_signature', message: 'Command signature is invalid' };
  if (msg.expiresAt <= ctx.now) return { code: 'expired', message: 'The command has expired' };
  if (msg.expiresAt > ctx.now + MAX_FUTURE_EXPIRY_MS) return { code: 'invalid_payload', message: 'The command expiry is too far in the future' };
  return null;
}
