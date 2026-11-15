import { describe, expect, it } from 'vitest';
import { findTrustedBin, resolveExecutable, resetTrustedBins, safeExecEnv } from './trusted-bin.js';

const files = (...paths: string[]) => (p: string) => paths.includes(p);

describe('findTrustedBin (M-18)', () => {
  it("POSIX: nisbiy/bo'sh PATH yozuvlari va cwd chiqariladi", () => {
    const isFile = files('/work/repo/git', './git', 'git', '/usr/bin/git');
    expect(findTrustedBin('git', { platform: 'linux', env: { PATH: ':.:bin:/work/repo:/usr/bin' }, cwd: '/work/repo', isFile })).toBe('/usr/bin/git');
    // cwd ichidagi (pastki) papka ham rad
    expect(findTrustedBin('git', { platform: 'linux', env: { PATH: '/work/repo/node_modules/.bin' }, cwd: '/work/repo', isFile: files('/work/repo/node_modules/.bin/git') })).toBeUndefined();
  });

  it("excludeDirs (loyiha ildizi) dagi PATH yozuvi rad etiladi; ildiz '/' cwd bo'lsa hamma narsani o'chirmaydi", () => {
    const isFile = files('/proj/bin/git', '/usr/bin/git');
    expect(findTrustedBin('git', { platform: 'darwin', env: { PATH: '/proj/bin:/usr/bin' }, cwd: '/', excludeDirs: ['/proj'], isFile })).toBe('/usr/bin/git');
  });

  it("Windows: repo-lokal git.exe (cwd) PATH'da '.' yoki cwd bo'lsa tanlanmaydi; faqat absolyut trusted yo'l", () => {
    const isFile = files('C:\\repo\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe');
    const env = { Path: '.;C:\\repo;C:\\Program Files\\Git\\cmd' };
    expect(findTrustedBin('git', { platform: 'win32', env, cwd: 'C:\\repo', isFile })).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(findTrustedBin('git', { platform: 'win32', env: { Path: '.;C:\\repo' }, cwd: 'C:\\repo', isFile })).toBeUndefined();
    // registr farqi (Windows katta-kichik harfga befarq)
    expect(findTrustedBin('git', { platform: 'win32', env: { Path: 'c:\\REPO' }, cwd: 'C:\\repo', isFile: files('c:\\REPO\\git.exe') })).toBeUndefined();
  });

  it("Windows: faqat .exe; claude uchun .cmd shim ham (allowShims)", () => {
    const isFile = files('C:\\bin\\claude.cmd');
    expect(findTrustedBin('claude', { platform: 'win32', env: { Path: 'C:\\bin' }, cwd: 'C:\\x', isFile })).toBeUndefined();
    expect(findTrustedBin('claude', { platform: 'win32', env: { Path: 'C:\\bin' }, cwd: 'C:\\x', isFile, allowShims: true })).toBe('C:\\bin\\claude.cmd');
  });
});

describe('resolveExecutable / safeExecEnv', () => {
  it("absolyut yo'l o'zi; separator'li nisbiy yo'l HECH QACHON; bare nom ishonchli PATH'dan", () => {
    resetTrustedBins();
    expect(resolveExecutable('/opt/homebrew/bin/claude', 'claude')).toBe('/opt/homebrew/bin/claude');
    expect(resolveExecutable('C:\\tools\\claude.exe', 'claude')).toBe('C:\\tools\\claude.exe');
    expect(resolveExecutable('./git', 'git')).toBeUndefined();
    expect(resolveExecutable('..\\git.exe', 'git')).toBeUndefined();
  });
  it('NoDefaultCurrentDirectoryInExePath qo\'yiladi', () => {
    expect(safeExecEnv({ A: '1' }, { B: '2' })).toMatchObject({ A: '1', B: '2', NoDefaultCurrentDirectoryInExePath: '1' });
  });
});
