import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname, platform } from 'node:os';
import { buildAgentAuthString } from '@commander/contracts';
import type { AgentdPaths } from './paths.js';
import { ensureHomeDir } from './config.js';

export interface GeneratedKey {
  privateKey: KeyObject;
  /** Xom 32 bayt Ed25519 public key, base64url (JWK `x`), enrollment shuni yuboradi. */
  publicKeyRaw: string;
}

export function generateDeviceKey(): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Ed25519 public key JWK export failed');
  return { privateKey, publicKeyRaw: x };
}

/** Maxfiy kalitni faylga yozadi (0600). Mavjud faylni ustidan yozmaydi (`wx`). Kalit logga chiqmaydi. */
export function storePrivateKey(paths: AgentdPaths, privateKey: KeyObject): void {
  ensureHomeDir(paths);
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  writeFileSync(paths.keyFile, pem, { flag: 'wx', mode: 0o600 });
  chmodSync(paths.keyFile, 0o600);
}

export function removePrivateKey(paths: AgentdPaths): void {
  if (existsSync(paths.keyFile)) unlinkSync(paths.keyFile);
}

export function loadPrivateKey(paths: AgentdPaths): KeyObject {
  return createPrivateKey({ key: readFileSync(paths.keyFile), format: 'pem', type: 'pkcs8' });
}

/** `auth.response.signature`: Ed25519 imzo `buildAgentAuthString` satri ustida, base64url. */
export function signAgentAuth(privateKey: KeyObject, parts: { nonce: string; ts: number; deviceId: string }): string {
  return sign(null, Buffer.from(buildAgentAuthString(parts), 'utf8'), privateKey).toString('base64url');
}

/** Barqaror apparat identifikatori: sha256(platforma UUID'si) hex (64 belgi). Xom UUID tashqariga chiqmaydi. */
export function computeHardwareId(): string {
  let raw = '';
  try {
    if (platform() === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? '';
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(f)) {
          raw = readFileSync(f, 'utf8').trim();
          if (raw) break;
        }
      }
    }
  } catch {
    raw = '';
  }
  if (!raw) raw = `fallback:${osHostname()}`;
  return createHash('sha256').update(`commander-hw:${raw}`).digest('hex');
}

/** Aylantirish paytidagi yangi kalit fayli (5.1): markaz qabul qilgach `device.key` ustiga atomik ko'chiriladi. */
export const nextKeyFile = (paths: AgentdPaths): string => `${paths.keyFile}.next`;

export function storeNextKey(paths: AgentdPaths, privateKey: KeyObject): void {
  ensureHomeDir(paths);
  writeFileSync(nextKeyFile(paths), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  chmodSync(nextKeyFile(paths), 0o600);
}

export function loadNextKey(paths: AgentdPaths): KeyObject | undefined {
  try {
    return createPrivateKey({ key: readFileSync(nextKeyFile(paths)), format: 'pem', type: 'pkcs8' });
  } catch {
    return undefined;
  }
}

/** `device.key.next` -> `device.key` (atomik `rename`; eski kalit shu bilan yo'qoladi). */
export function promoteNextKey(paths: AgentdPaths): void {
  renameSync(nextKeyFile(paths), paths.keyFile);
}

export function discardNextKey(paths: AgentdPaths): void {
  try {
    unlinkSync(nextKeyFile(paths));
  } catch {
    /* yo'q bo'lsa ham yaxshi */
  }
}

/** Xom 32 bayt public key (base64url). */
export function publicKeyRawOf(privateKey: KeyObject): string {
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Ed25519 public key JWK export failed');
  return x;
}
