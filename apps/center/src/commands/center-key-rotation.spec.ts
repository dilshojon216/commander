import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSignerKeys } from './command-signer.js';
import {
  fingerprintOfRaw,
  readRotations,
  recoverRotations,
  rotateSignerKeyFile,
  rotationsFileOf,
  rotationsFrom,
  validChain,
  verifyRotation,
} from './center-key-rotation.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmdr-ckr-'));
  file = join(dir, 'command-signing.key');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;

describe('rotateSignerKeyFile', () => {
  it('replaces the key (0600), signs the announcement with the OLD key and keeps no old secret', () => {
    const first = loadOrCreateSignerKeys(file);
    const now = 1_800_000_000_000;
    const r = rotateSignerKeyFile(file, now, 30);
    const second = loadOrCreateSignerKeys(file);
    expect(second.publicKeyRaw).toBe(r.newPublicKey);
    expect(second.publicKeyRaw).not.toBe(first.publicKeyRaw);
    expect(r.previousFingerprint).toBe(first.fingerprint);
    expect(r.newFingerprint).toBe(second.fingerprint);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);

    expect(r.rotation.previousPublicKey).toBe(first.publicKeyRaw);
    expect(r.rotation.expiresAt - r.rotation.issuedAt).toBe(30 * DAY);
    expect(verifyRotation(r.rotation)).toBe(true);
    expect(verifyRotation({ ...r.rotation, newPublicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string })).toBe(false); // almashtirilgan yangi kalit
    expect(verifyRotation({ ...r.rotation, expiresAt: r.rotation.expiresAt + 1 })).toBe(false);

    // Faylda faqat ochiq e'lon (maxfiy kalit emas).
    const stored = readFileSync(rotationsFileOf(file), 'utf8');
    expect(stored).not.toContain('PRIVATE');
    expect(readRotations(file, now + DAY)).toHaveLength(1);
    expect(readRotations(file, now + 31 * DAY)).toHaveLength(0); // oyna tugadi
  });

  it('chains consecutive rotations (A->B->C) and an agent pinned to A receives both in order', () => {
    const a = loadOrCreateSignerKeys(file);
    const t = 1_800_000_000_000;
    const r1 = rotateSignerKeyFile(file, t, 30);
    const r2 = rotateSignerKeyFile(file, t + DAY, 30);
    const current = loadOrCreateSignerKeys(file).publicKeyRaw;
    const chain = validChain(readRotations(file, t + 2 * DAY), current);
    expect(chain.map((c) => c.newPublicKey)).toEqual([r1.newPublicKey, r2.newPublicKey]);
    expect(rotationsFrom(chain, a.fingerprint).map((c) => c.newPublicKey)).toEqual([r1.newPublicKey, r2.newPublicKey]);
    expect(rotationsFrom(chain, r1.newFingerprint).map((c) => c.newPublicKey)).toEqual([r2.newPublicKey]);
    expect(rotationsFrom(chain, r2.newFingerprint)).toEqual([]);
    expect(rotationsFrom(chain, undefined)).toEqual([]);
    expect(rotationsFrom(chain, 'deadbeefdeadbeef')).toEqual([]);
  });

  it('fail-safe: a chain that does not end at the current key announces nothing', () => {
    loadOrCreateSignerKeys(file);
    const r = rotateSignerKeyFile(file, Date.now(), 30);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;
    expect(validChain([r.rotation], other)).toEqual([]);
    expect(validChain([], r.newPublicKey)).toEqual([]);
    // Uzilgan zanjir: faqat oxirgi ulangan qism qoladi.
    const broken = [{ ...r.rotation, previousPublicKey: other, newPublicKey: other }, r.rotation];
    expect(validChain(broken, r.newPublicKey)).toEqual([r.rotation]);
  });

  it('crash between key swap and state write: recoverRotations completes it only if the new key is current', () => {
    loadOrCreateSignerKeys(file);
    const r = rotateSignerKeyFile(file, Date.now(), 30);
    // Yarim qolgan holatni taqlid: tayyor fayl .tmp ga qaytariladi.
    renameSync(rotationsFileOf(file), `${rotationsFileOf(file)}.tmp`);
    expect(readRotations(file)).toHaveLength(0);
    const keys = loadOrCreateSignerKeys(file); // yuklash tiklaydi
    expect(keys.publicKeyRaw).toBe(r.newPublicKey);
    expect(readRotations(file)).toHaveLength(1);
    expect(existsSync(`${rotationsFileOf(file)}.tmp`)).toBe(false);

    // Boshqa kalitga tegishli .tmp tashlanadi (noto'g'ri kalitga pin qildirmaydi).
    writeFileSync(`${rotationsFileOf(file)}.tmp`, JSON.stringify([{ ...r.rotation, newPublicKey: fingerprintOfRaw(r.newPublicKey).padEnd(43, 'A') }]));
    recoverRotations(file, r.newPublicKey);
    expect(existsSync(`${rotationsFileOf(file)}.tmp`)).toBe(false);
  });

  it('validates input and the key file', () => {
    expect(() => rotateSignerKeyFile(file)).toThrow(/does not exist/);
    loadOrCreateSignerKeys(file);
    expect(() => rotateSignerKeyFile(file, Date.now(), 0)).toThrow(/overlap-days/);
    expect(() => rotateSignerKeyFile(file, Date.now(), 400)).toThrow(/overlap-days/);
    // Buzuq e'lon fayli: bo'sh deb hisoblanadi.
    writeFileSync(rotationsFileOf(file), '{not json');
    expect(readRotations(file)).toEqual([]);
    // Yangi kalit haqiqiy Ed25519 PKCS8.
    const pem = readFileSync(file);
    expect(createPublicKey(createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })).asymmetricKeyType).toBe('ed25519');
  });
});
