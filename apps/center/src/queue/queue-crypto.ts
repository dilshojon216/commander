import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Navbat promptini diskda shifrlash (AES-256-GCM). Prompt keyinroq bajarilishi kerak, shu sabab saqlanadi, lekin faqat
 * shifrlangan: kalit markaz sirlar volume'ida (`CENTER_KEY_FILE` yonida `queue-prompt.key`, 0600), DB'da va loglarda YO'Q.
 * Format: `01 | iv(12) | tag(16) | ciphertext`. AAD = navbat elementi id'si: shifrmatnni boshqa qatorga ko'chirib bo'lmaydi.
 */

const VERSION = 1;
const KEY_BYTES = 32;

export function loadOrCreateQueueKey(file: string | null): Buffer {
  if (file === null) return randomBytes(KEY_BYTES); // testlar: xotirada
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) chmodSync(file, 0o600);
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new Error('queue key file is corrupt (expected 32 bytes)');
    return key;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}

export function encryptPrompt(key: Buffer, itemId: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(itemId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

/** Buzilgan/begona kalit/boshqa qator => Error (matn xatoga tushmaydi). */
export function decryptPrompt(key: Buffer, itemId: string, blob: Buffer): string {
  if (blob.length < 1 + 12 + 16 || blob[0] !== VERSION) throw new Error('queue prompt blob is invalid');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(itemId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
}
