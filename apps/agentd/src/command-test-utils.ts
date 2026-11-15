import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { buildCommandSigString } from '@commander/contracts';
import type { CommandDispatchPayload } from '@commander/contracts';
import { payloadSha256 } from './command-verify.js';

/** Faqat testlar uchun: markaz imzosini (center `signCommand`) takrorlaydigan yordamchi. */
export interface TestCenter {
  privateKey: KeyObject;
  publicKey: string;
}

export function newTestCenter(): TestCenter {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: createPublicKey(privateKey).export({ format: 'jwk' }).x as string };
}

export function signDispatch(
  center: TestCenter,
  deviceId: string,
  body: Pick<CommandDispatchPayload, 'type' | 'payload'>,
  over: { commandId?: string; nonce?: string; expiresAt?: number; now?: number } = {},
): CommandDispatchPayload {
  const commandId = over.commandId ?? randomUUID();
  const nonce = over.nonce ?? randomBytes(32).toString('base64url');
  const expiresAt = over.expiresAt ?? (over.now ?? Date.now()) + 60_000;
  const sig = sign(null, Buffer.from(buildCommandSigString({ deviceId, commandId, type: body.type, nonce, expiresAt, payloadSha256: payloadSha256(body.payload) }), 'utf8'), center.privateKey).toString('base64url');
  return { commandId, nonce, expiresAt, sig, type: body.type, payload: body.payload } as CommandDispatchPayload;
}
