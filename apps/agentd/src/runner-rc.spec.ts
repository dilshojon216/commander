import { describe, expect, it, vi } from 'vitest';
import type { AgentEntry } from './agents-full.js';
import { createLogger } from './logger.js';
import { CommandRunner, buildStartArgs } from './runner.js';
import { TmuxLocator } from './tmux.js';
import type { TmuxExec } from './tmux.js';

const log = createLogger({ write: () => undefined });
const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
const ID = 'session_01Lb25s1rUPNVGEwNscyZi6y';
const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({ claudeSessionId: SID, shortId: 'a1b97ff9', pid: 100, cwd: '/w/proj', kind: 'bg', status: 'idle', state: 'done', ...over });

describe('buildStartArgs: --remote-control (3.10)', () => {
  it('nomsiz: bayroq keyin doim boshqa --bayroq (nom o\'rniga yutilmaydi)', () => {
    const a = buildStartArgs({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', remoteControl: true });
    expect(a).toEqual(['--bg', '--remote-control', '--permission-mode', 'plan', '--', 'hi']);
  });
  it('nom bilan: --remote-control <nom> va -n <nom>', () => {
    expect(buildStartArgs({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', remoteControl: true, name: 'nightly rc' })).toEqual([
      '--bg', '--remote-control', 'nightly rc', '-n', 'nightly rc', '--permission-mode', 'plan', '--', 'hi',
    ]);
  });
  it('remoteControl yo\'q yoki false: bayroq qo\'shilmaydi; prompt hamon `--` dan keyin', () => {
    for (const rc of [undefined, false]) {
      const a = buildStartArgs({ cwd: '/w', prompt: '--remote-control', permissionMode: 'default', ...(rc === undefined ? {} : { remoteControl: rc }) });
      expect(a.filter((x) => x === '--remote-control')).toHaveLength(1);
      expect(a.at(-1)).toBe('--remote-control');
      expect(a.at(-2)).toBe('--');
      expect(a.indexOf('--remote-control')).toBe(a.length - 1);
    }
  });
});

describe('CommandRunner.start + remoteControl', () => {
  function mk(bridge: (pid: number) => string | null) {
    let t = 0;
    let listed = 0;
    const exec = vi.fn(async () => 'backgrounded · deadbeef · task\n');
    const runner = new CommandRunner({
      claudeBin: 'claude',
      list: async () => (++listed <= 1 ? [] : [entry({ claudeSessionId: 'new-sess', shortId: 'deadbeef', pid: 9 })]),
      log,
      exec,
      sleep: async (ms) => void (t += ms),
      now: () => t,
      platform: 'darwin',
      uid: 501,
      bridgeId: bridge,
      timeouts: { correlateMs: 3000, pollMs: 500, rcConfirmMs: 2000 },
    });
    return { runner, exec };
  }
  it('RC tasdiqlandi: natijada remoteControl {enabled, name, url}', async () => {
    const { runner, exec } = mk(() => ID);
    const out = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', remoteControl: true, name: 'my rc' }, '/w');
    expect(out).toMatchObject({ ok: true, result: { claudeSessionId: 'new-sess', remoteControl: { enabled: true, name: 'my rc', url: `https://claude.ai/code/${ID}` } } });
    expect(exec).toHaveBeenCalledWith(expect.arrayContaining(['--remote-control', 'my rc']), expect.anything());
  });
  it('RC tasdiqlanmasa: sessiya ochiladi, lekin remoteControl yo\'q (taxmin qilinmaydi)', async () => {
    const { runner } = mk(() => null);
    const out = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', remoteControl: true }, '/w');
    expect(out.ok).toBe(true);
    expect(out.result?.remoteControl).toBeUndefined();
    expect(out.result?.detail).toContain('not confirmed');
  });
  it('RC so\'ralmasa bridge tekshirilmaydi', async () => {
    const bridge = vi.fn(() => ID);
    const { runner } = mk(bridge);
    const out = await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' }, '/w');
    expect(out.result?.remoteControl).toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('CommandRunner.remoteControl (tmux)', () => {
  const tentry = (over: Partial<AgentEntry> = {}): AgentEntry => entry({ kind: 'interactive', shortId: undefined, pid: 200, status: 'idle', ...over });
  const PS = (fg = 200) => ` 100 1 100 100 501 ttys004\n 200 100 200 ${fg} 501 ttys004\n`;
  const PANE_ACTIVE = `❯ /remote-control\n  /remote-control is active · Continue here\n  https://claude.ai/code/${ID}\n`;

  function mkRunner(over: { status?: string; fg?: number; localStatus?: string; enabled?: boolean; panes?: string; platform?: string } = {}) {
    const calls: string[][] = [];
    let enabled = over.enabled ?? false;
    const texec: TmuxExec = {
      tmux: async (_s, args) => {
        calls.push(args);
        if (args[0] === 'list-panes') return over.panes ?? '100 %4 /dev/ttys004 s:0.0\n';
        if (args[0] === 'send-keys' && args.at(-1) === 'Enter') enabled = true;
        if (args[0] === 'capture-pane') return enabled ? PANE_ACTIVE : 'idle';
        return '';
      },
      ps: async () => PS(over.fg),
      available: async () => true,
    };
    const fs = { readdir: () => ['default'], lstat: (p: string) => ({ isSocket: p.endsWith('default'), isDirectory: !p.endsWith('default'), isSymlink: false, uid: 501, mode: 0o700 }) };
    const tmux = new TmuxLocator({ exec: texec, uid: 501, platform: over.platform ?? 'darwin', tmpdirs: () => ['/tmp'], fs, cacheMs: 0 });
    let t = 0;
    const runner = new CommandRunner({
      claudeBin: 'claude',
      list: async () => [tentry({ status: over.status ?? 'idle' })],
      log,
      exec: vi.fn(async () => ''),
      sleep: async (ms) => void (t += ms),
      now: () => t,
      platform: over.platform ?? 'darwin',
      uid: 501,
      tmux,
      bridgeState: () => ({ known: true, id: enabled ? ID : null }),
      ...(over.localStatus ? { localStatus: () => over.localStatus } : {}),
      timeouts: { pollMs: 100 },
    });
    const sends = () => calls.filter((c) => c[0] === 'send-keys');
    return { runner, sends };
  }

  it('yoqish: send-keys -l "/remote-control <nom>" + Enter, havola qaytadi', async () => {
    const { runner, sends } = mkRunner();
    const out = await runner.remoteControl({ claudeSessionId: SID, enable: true, name: 'my rc' }, tentry());
    expect(out).toMatchObject({ ok: true, result: { detail: 'enabled', remoteControl: { enabled: true, name: 'my rc', url: `https://claude.ai/code/${ID}` } } });
    expect(sends()).toEqual([['send-keys', '-t', '%4', '-l', '--', '/remote-control my rc'], ['send-keys', '-t', '%4', 'Enter']]);
  });
  it('busy / ruxsat kutayotgan sessiyaga hech narsa yuborilmaydi', async () => {
    const a = mkRunner({ status: 'busy' });
    expect(await a.runner.remoteControl({ claudeSessionId: SID, enable: true }, tentry())).toMatchObject({ ok: false, code: 'session_busy' });
    expect(a.sends()).toHaveLength(0);
    const b = mkRunner({ localStatus: 'awaiting_approval' });
    expect(await b.runner.remoteControl({ claudeSessionId: SID, enable: true }, tentry())).toMatchObject({ ok: false, code: 'session_busy' });
    expect(b.sends()).toHaveLength(0);
  });
  it('bg sessiya: remote_control_unsupported; pane yo\'q: interactive_session; shell\'ga o\'tilgan: not_owned', async () => {
    const m = mkRunner();
    expect(await m.runner.remoteControl({ claudeSessionId: SID, enable: true }, entry())).toMatchObject({ ok: false, code: 'remote_control_unsupported' });
    expect(await mkRunner({ panes: '' }).runner.remoteControl({ claudeSessionId: SID, enable: true }, tentry())).toMatchObject({ ok: false, code: 'interactive_session' });
    const sh = mkRunner({ fg: 100 });
    expect(await sh.runner.remoteControl({ claudeSessionId: SID, enable: true }, tentry())).toMatchObject({ ok: false, code: 'not_owned' });
    expect(sh.sends()).toHaveLength(0);
  });
  it('xavfsiz bo\'lmagan nom rad etiladi', async () => {
    const { runner, sends } = mkRunner();
    expect(await runner.remoteControl({ claudeSessionId: SID, enable: true, name: 'a; /exit' }, tentry())).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(sends()).toHaveLength(0);
  });
  it('allaqachon yoniq: hech narsa yuborilmaydi', async () => {
    const { runner, sends } = mkRunner({ enabled: true });
    expect(await runner.remoteControl({ claudeSessionId: SID, enable: true }, tentry())).toMatchObject({ ok: true, result: { detail: 'already enabled' } });
    expect(sends()).toHaveLength(0);
  });
});
