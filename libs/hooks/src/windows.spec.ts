import { homedir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCcHook } from './cc-hook-lib.js';
import { resolveShell } from './shell.js';
import { resolveSocketPath } from './socket-path.js';
import { PassThrough } from 'node:stream';

describe('resolveSocketPath', () => {
  it("POSIX: ~/.commander/agentd.sock (avvalgidek), env override'lar", () => {
    if (process.platform !== 'win32') expect(resolveSocketPath({}, 'darwin')).toBe(join(homedir(), '.commander', 'agentd.sock'));
    expect(resolveSocketPath({ COMMANDER_HOME: '/tmp/h' }, 'linux')).toBe('/tmp/h/agentd.sock');
    expect(resolveSocketPath({ COMMANDER_SOCKET: '/tmp/s' }, 'linux')).toBe('/tmp/s');
  });

  it('Windows: named pipe (foydalanuvchi nomi bilan)', () => {
    const p = resolveSocketPath({}, 'win32');
    expect(p.startsWith('\\\\.\\pipe\\commander-agentd-')).toBe(true);
    expect(p.toLowerCase()).toContain(userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase());
  });
});

describe('resolveShell', () => {
  it("POSIX: /bin/sh -c", () => {
    expect(resolveShell('linux', {})).toEqual({ file: '/bin/sh', args: ['-c'] });
    expect(resolveShell('darwin', {})).toEqual({ file: '/bin/sh', args: ['-c'] });
  });

  it("Windows: Git Bash (CLAUDE_CODE_GIT_BASH_PATH, keyin Program Files); WSL bash.exe HECH QACHON", () => {
    const exists = (p: string): boolean => ['C:\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe'].includes(p);
    expect(resolveShell('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' }, exists)?.file).toBe('C:\\Git\\bin\\bash.exe');
    expect(resolveShell('win32', { ProgramFiles: 'C:\\Program Files' }, exists)?.file).toBe(win32.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'));
    expect(resolveShell('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Windows\\System32\\bash.exe' }, exists)).toBeNull();
    expect(resolveShell('win32', {}, () => false)).toBeNull();
  });
});

describe('cc-hook fail-safe (Windows pipe yo\'q)', () => {
  it("named pipe mavjud emas: tez, jim, exit 0, stdout bo'sh", async () => {
    const stdin = new PassThrough();
    stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'zz', cwd: 'C:\\Users\\x\\p' }));
    const out: string[] = [];
    const t0 = Date.now();
    const code = await runCcHook([], {
      stdin,
      stdout: { write: (s) => out.push(s) },
      env: {},
      socketPath: '\\\\.\\pipe\\commander-agentd-mavjud-emas-test',
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
