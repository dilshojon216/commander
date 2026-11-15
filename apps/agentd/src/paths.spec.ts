import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from './paths.js';

describe('resolvePaths', () => {
  it('POSIX: socket <home>/agentd.sock (avvalgidek)', () => {
    const p = resolvePaths('/tmp/h', 'linux', {});
    expect(p.socketFile).toBe('/tmp/h/agentd.sock');
    expect(p.keyFile).toBe(join('/tmp/h', 'device.key'));
    const d = resolvePaths(join(homedir(), '.commander'), process.platform, {});
    if (process.platform !== 'win32') expect(d.socketFile).toBe(join(homedir(), '.commander', 'agentd.sock'));
  });

  it("Windows: named pipe; maxsus home bo'lsa xesh bilan, COMMANDER_SOCKET ustun", () => {
    const def = resolvePaths(join(homedir(), '.commander'), 'win32', {});
    // standart home: faqat foydalanuvchi nomi (cc-hook ham shuni hisoblaydi)
    expect(def.socketFile).toMatch(/^\\\\\.\\pipe\\commander-agentd-[a-z0-9._-]+$/);
    const custom = resolvePaths('C:\\tmp\\h', 'win32', {});
    expect(custom.socketFile).toMatch(/^\\\\\.\\pipe\\commander-agentd-[a-z0-9._-]+-[0-9a-f]{8}$/);
    expect(resolvePaths('C:\\tmp\\h', 'win32', { COMMANDER_SOCKET: '\\\\.\\pipe\\x' }).socketFile).toBe('\\\\.\\pipe\\x');
  });
});
