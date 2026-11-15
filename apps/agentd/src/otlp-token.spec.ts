import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateOtlpToken } from './otlp-token.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): { otlpTokenFile: string } => {
  const d = mkdtempSync(join(tmpdir(), 'otlp-'));
  dirs.push(d);
  return { otlpTokenFile: join(d, 'otlp-token') };
};

describe('loadOrCreateOtlpToken (M-20)', () => {
  it("yaratadi (0600), keyingi chaqiruvlar bir xil tokenni qaytaradi, 43 belgi base64url", () => {
    const p = tmp();
    const t = loadOrCreateOtlpToken(p);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loadOrCreateOtlpToken(p)).toBe(t);
    if (process.platform !== 'win32') expect(statSync(p.otlpTokenFile).mode & 0o777).toBe(0o600);
  });
  it("mavjud yaroqli faylni o'qiydi; yaroqsizni jim almashtirmaydi (xato)", () => {
    const p = tmp();
    writeFileSync(p.otlpTokenFile, 'a'.repeat(40) + '\n');
    expect(loadOrCreateOtlpToken(p)).toBe('a'.repeat(40));
    writeFileSync(p.otlpTokenFile, 'x\n');
    expect(() => loadOrCreateOtlpToken(p)).toThrow();
  });
});
