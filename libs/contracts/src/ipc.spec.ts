import { describe, expect, it } from 'vitest';
import { commanderHome, isWindowsPipePath, normalizeProjectPath, resolveIpcPath, windowsPipePath } from './ipc.js';

describe('resolveIpcPath', () => {
  it('POSIX: <home>/.commander/agentd.sock (macOS va Linux)', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(resolveIpcPath({ env: {}, platform, homeDir: '/Users/dil' })).toBe('/Users/dil/.commander/agentd.sock');
    }
    expect(resolveIpcPath({ env: {}, platform: 'linux', homeDir: '/home/u/' })).toBe('/home/u/.commander/agentd.sock');
  });

  it("COMMANDER_HOME POSIX'da socket yo'lini siljitadi, COMMANDER_SOCKET hamma narsadan ustun", () => {
    expect(resolveIpcPath({ env: { COMMANDER_HOME: '/tmp/h' }, platform: 'linux', homeDir: '/x' })).toBe('/tmp/h/agentd.sock');
    expect(resolveIpcPath({ env: { COMMANDER_HOME: '/tmp/h', COMMANDER_SOCKET: '/tmp/s.sock' }, platform: 'darwin', homeDir: '/x' })).toBe('/tmp/s.sock');
    expect(resolveIpcPath({ env: { COMMANDER_SOCKET: '\\\\.\\pipe\\custom' }, platform: 'win32', homeDir: 'C:\\Users\\a' })).toBe('\\\\.\\pipe\\custom');
  });

  it('Windows: named pipe, foydalanuvchi nomi bilan', () => {
    const p = resolveIpcPath({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\User', username: 'user' });
    expect(p).toBe('\\\\.\\pipe\\commander-agentd-user');
    expect(isWindowsPipePath(p)).toBe(true);
    expect(isWindowsPipePath('/tmp/agentd.sock')).toBe(false);
  });

  it("Windows: foydalanuvchi nomi tozalanadi (pipe nomida taqiqlangan belgilar yo'q), env'ga qaytadi", () => {
    expect(windowsPipePath({ env: {}, platform: 'win32', homeDir: 'C:\\', username: 'DOMAIN\\Ali Valiyev' })).toBe('\\\\.\\pipe\\commander-agentd-domain_ali_valiyev');
    expect(windowsPipePath({ env: { USERNAME: 'Bob' }, platform: 'win32', homeDir: 'C:\\' })).toBe('\\\\.\\pipe\\commander-agentd-bob');
    expect(windowsPipePath({ env: {}, platform: 'win32', homeDir: 'C:\\' })).toBe('\\\\.\\pipe\\commander-agentd-user');
  });

  it("Windows: maxsus COMMANDER_HOME turli pipe beradi (testlar to'qnashmaydi), bir xil home bir xil nom", () => {
    const a = windowsPipePath({ env: { COMMANDER_HOME: 'C:\\t\\a' }, platform: 'win32', homeDir: 'C:\\', username: 'u' });
    const b = windowsPipePath({ env: { COMMANDER_HOME: 'C:\\t\\b' }, platform: 'win32', homeDir: 'C:\\', username: 'u' });
    const a2 = windowsPipePath({ env: { COMMANDER_HOME: 'c:\\T\\A' }, platform: 'win32', homeDir: 'C:\\', username: 'u' });
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
    expect(a).toMatch(/^\\\\\.\\pipe\\commander-agentd-u-[0-9a-f]{8}$/);
  });
});

describe('commanderHome', () => {
  it("platformaga mos ajratgich va override", () => {
    expect(commanderHome({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\.commander');
    expect(commanderHome({ env: {}, platform: 'darwin', homeDir: '/Users/a' })).toBe('/Users/a/.commander');
    expect(commanderHome({ env: { COMMANDER_HOME: '/z' }, platform: 'linux', homeDir: '/Users/a' })).toBe('/z');
  });
});

describe('normalizeProjectPath', () => {
  it("POSIX: aynan o'zgarishsiz", () => {
    for (const p of ['/Users/a/proj', '/a/b/', '/', 'C:\\kutilmagan\\lekin\\posix']) expect(normalizeProjectPath(p, 'linux')).toBe(p);
    expect(normalizeProjectPath('/Users/a/proj', 'darwin')).toBe('/Users/a/proj');
  });

  it('Windows: bir loyihaning barcha yozilishlari bitta qiymatga keladi', () => {
    const variants = ['C:\\Users\\Dil\\proj', 'c:\\Users\\Dil\\proj', 'C:/Users/Dil/proj', 'c:/Users/Dil/proj/', 'C:\\Users\\Dil\\\\proj\\', '\\\\?\\C:\\Users\\Dil\\proj'];
    for (const v of variants) expect(normalizeProjectPath(v, 'win32')).toBe('C:/Users/Dil/proj');
  });

  it('Windows: disk ildizi va UNC', () => {
    expect(normalizeProjectPath('c:\\', 'win32')).toBe('C:/');
    expect(normalizeProjectPath('C:', 'win32')).toBe('C:/');
    expect(normalizeProjectPath('\\\\srv\\share\\p\\', 'win32')).toBe('//srv/share/p');
  });

  it("Windows: papka nomlarining harf registri o'zgarmaydi", () => {
    expect(normalizeProjectPath('d:\\Work\\MyApp', 'win32')).toBe('D:/Work/MyApp');
  });
});
