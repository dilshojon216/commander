import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptPrompt, encryptPrompt, loadOrCreateQueueKey } from './queue-crypto.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('queue crypto', () => {
  it('round-trip, shifrmatnda ochiq matn yo\'q', () => {
    const key = loadOrCreateQueueKey(null);
    const blob = encryptPrompt(key, ID, 'sk-ant-secret deploy to prod');
    expect(blob.toString('utf8')).not.toContain('secret');
    expect(decryptPrompt(key, ID, blob)).toBe('sk-ant-secret deploy to prod');
  });

  it('boshqa qator id, boshqa kalit, buzilgan blob => xato', () => {
    const key = loadOrCreateQueueKey(null);
    const blob = encryptPrompt(key, ID, 'x');
    expect(() => decryptPrompt(key, '22222222-2222-4222-8222-222222222222', blob)).toThrow();
    expect(() => decryptPrompt(loadOrCreateQueueKey(null), ID, blob)).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => decryptPrompt(key, ID, bad)).toThrow();
    expect(() => decryptPrompt(key, ID, Buffer.from([1, 2]))).toThrow();
  });

  it('tag qisqartirilgan yoki o\'zgartirilgan blob => xato', () => {
    const key = loadOrCreateQueueKey(null);
    const blob = encryptPrompt(key, ID, 'hello world');
    // tag = baytlar 13..28
    const altered = Buffer.from(blob);
    altered[13] ^= 0xff;
    expect(() => decryptPrompt(key, ID, altered)).toThrow();
    // qisqartirilgan tag: tag oxirgi baytlarini olib tashlab, shifrmatnni siljitish
    const truncatedTag = Buffer.concat([blob.subarray(0, 13), blob.subarray(13, 17), blob.subarray(29)]);
    expect(() => decryptPrompt(key, ID, truncatedTag)).toThrow();
    // butunlay tagsiz
    expect(() => decryptPrompt(key, ID, blob.subarray(0, 13))).toThrow();
  });

  it('kalit fayli 0600, qayta o\'qiladi', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qk-')), 'sub', 'queue-prompt.key');
    const a = loadOrCreateQueueKey(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateQueueKey(file).equals(a)).toBe(true);
  });
});
