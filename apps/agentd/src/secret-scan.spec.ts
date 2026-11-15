import { describe, expect, it } from 'vitest';
import { envFileFinding, envLikeKind, scanTextForSecrets, shouldSkipFile } from './secret-scan.js';

const FAKE_GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const FAKE_AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';

describe('secret-scan', () => {
  it('aniq shakllarni nomli qoida bilan topadi, qiymatni qaytarmaydi', () => {
    const text = ['const a = 1;', `const t = "${FAKE_GH}";`, `aws = ${FAKE_AWS}`, '-----BEGIN RSA PRIVATE KEY-----'].join('\n');
    const hits = scanTextForSecrets(text);
    expect(hits.map((h) => [h.line, h.rule])).toEqual([[2, 'github-token'], [3, 'aws-access-key'], [4, 'private-key']]);
    const json = JSON.stringify(hits);
    expect(json).not.toContain(FAKE_GH);
    expect(json).not.toContain(FAKE_AWS);
  });
  it('NAME = "haqiqiy qiymat" topiladi; o\'rin egasi/o\'zgaruvchi topilmaydi', () => {
    expect(scanTextForSecrets('DB_PASSWORD = "Xk29sLq81mzPw0Qa"')[0]).toMatchObject({ rule: 'secret-assignment' });
    expect(scanTextForSecrets('API_KEY=${API_KEY_FROM_ENV_VAR}')).toEqual([]);
    expect(scanTextForSecrets('password: "your-password-here-please"')).toEqual([]);
    expect(scanTextForSecrets('const token = process.env.SOME_LONG_TOKEN_NAME_X')).toEqual([]);
  });
  it('URL ichidagi login:parol', () => {
    expect(scanTextForSecrets('url = "postgres://admin:hunter2pass@db.internal:5432/app"')[0]!.rule).toBe('url-credentials');
  });
  it('.env-ga o\'xshash fayllar', () => {
    expect(envLikeKind('.env')).toBe('env');
    expect(envLikeKind('apps/x/.env.production')).toBe('env');
    expect(envLikeKind('.env.example')).toBeNull();
    expect(envLikeKind('a/.env.sample')).toBeNull();
    expect(envLikeKind('certs/server.pem')).toBe('key');
    expect(envLikeKind('id_rsa')).toBe('key');
    expect(envLikeKind('id_rsa.pub')).toBeNull();
    expect(envLikeKind('src/env.ts')).toBeNull();
    expect(envFileFinding('.env')).toMatchObject({ kind: 'env_file', severity: 'moderate', file: '.env', rule: 'env-file' });
    expect(envFileFinding('k.keystore')!.severity).toBe('high');
  });
  it('lock/binar fayllar o\'tkaziladi', () => {
    expect(shouldSkipFile('package-lock.json')).toBe(true);
    expect(shouldSkipFile('a/b/pnpm-lock.yaml')).toBe(true);
    expect(shouldSkipFile('logo.png')).toBe(true);
    expect(shouldSkipFile('src/a.ts')).toBe(false);
  });
});
