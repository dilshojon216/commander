import { describe, expect, it, vi } from 'vitest';
import type { AgentEntry } from './agents-full.js';
import { buildClaudeCommand } from './claude-exec.js';
import { createLogger } from './logger.js';
import { TmuxLocator } from './tmux.js';
import type { TmuxExec } from './tmux.js';
import { CommandRunner, MODE_TO_CLI, buildResumeArgs, buildStartArgs, buildStopArgs, parseBackgrounded } from './runner.js';

const log = createLogger({ write: () => undefined });
const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({ claudeSessionId: SID, shortId: 'a1b97ff9', pid: 100, cwd: '/w/proj', kind: 'bg', status: 'idle', state: 'done', ...over });

describe('argument builders (hech qachon shell satri emas)', () => {
  it('start: --bg, rejim CLI nomiga, prompt `--` dan KEYIN', () => {
    expect(buildStartArgs({ cwd: '/w', prompt: 'hello world', permissionMode: 'default', model: 'haiku', name: 'my task' })).toEqual([
      '--bg', '-n', 'my task', '--model', 'haiku', '--permission-mode', 'manual', '--', 'hello world',
    ]);
    expect(MODE_TO_CLI).toEqual({ default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto' });
  });
  it('bayroq ko\'rinishidagi / shell metabelgili prompt bitta argument bo\'lib qoladi', () => {
    for (const prompt of ['--dangerously-skip-permissions', '-p x', '$(rm -rf ~); `id` | cat & echo "x"', 'a\nb']) {
      const args = buildStartArgs({ cwd: '/w', prompt, permissionMode: 'plan' });
      expect(args.at(-1)).toBe(prompt);
      expect(args.at(-2)).toBe('--');
      expect(args.filter((a) => a === prompt)).toHaveLength(1);
      const r = buildResumeArgs(SID, prompt);
      expect(r).toEqual(['--bg', '--resume', SID, '--', prompt]); // bayroqsiz: nusxa ochilmasin
    }
  });
  it('rejim bayroqsiz bypass yo\'q: hech qaysi CLI rejimi bypass/dontAsk emas', () => {
    expect(Object.values(MODE_TO_CLI).some((m) => /bypass|dontAsk/i.test(m))).toBe(false);
  });
  it('stop faqat qisqa id', () => {
    expect(buildStopArgs('a1b97ff9')).toEqual(['stop', 'a1b97ff9']);
  });
  it('Windows .cmd shim: erkin matn rad etiladi (cmd.exe orqali o\'tkazilmaydi), `stop <id>` o\'tadi', () => {
    expect(() => buildClaudeCommand('C:\\x\\claude.cmd', buildStartArgs({ cwd: 'C:\\w', prompt: 'a & calc', permissionMode: 'plan' }), 'win32')).toThrow();
    expect(buildClaudeCommand('C:\\x\\claude.cmd', buildStopArgs('a1b97ff9'), 'win32', 'cmd.exe').file).toBe('cmd.exe');
    expect(buildClaudeCommand('C:\\x\\claude.exe', buildStartArgs({ cwd: 'C:\\w', prompt: 'a & calc', permissionMode: 'plan' }), 'win32').file).toBe('C:\\x\\claude.exe');
  });
  it('parseBackgrounded', () => {
    expect(parseBackgrounded('Starting…\nbackgrounded · a1b97ff9 · cmdr-spike\n')).toEqual({ shortId: 'a1b97ff9', copyOf: null });
    expect(parseBackgrounded('note: session dc2ff552 is already running in the background, so this started a copy as df27317c.\nbackgrounded · df27317c\n')).toEqual({ shortId: 'df27317c', copyOf: 'df27317c' });
  });
});

function mk(over: { entries?: () => AgentEntry[]; exec?: (args: string[], o: { cwd?: string; timeoutMs: number }) => Promise<string>; platform?: string; procInfo?: () => Promise<{ uid: number; command: string } | null>; signal?: (pid: number, s: 'SIGINT') => void; holds?: (id: string) => boolean } = {}) {
  let t = 0;
  const exec = vi.fn(over.exec ?? (async () => ''));
  const runner = new CommandRunner({
    claudeBin: 'claude',
    list: async () => (over.entries ?? (() => [entry()]))(),
    log,
    exec,
    sleep: async (ms) => void (t += ms),
    now: () => t,
    platform: over.platform ?? 'darwin',
    uid: 501,
    ...(over.procInfo ? { procInfo: over.procInfo } : {}),
    ...(over.signal ? { signal: over.signal } : {}),
    supervisorHolds: over.holds ?? (() => false),
    timeouts: { stopWaitMs: 3000, correlateMs: 3000, pollMs: 500 },
  });
  return { runner, exec, clock: () => t };
}

describe('CommandRunner.start', () => {
  it('claude --bg ni cwd bilan ishga tushiradi va qisqa id bo\'yicha sessionId\'ga bog\'laydi', async () => {
    let listed = 0;
    const { runner, exec } = mk({
      entries: () => (++listed <= 1 ? [] : [entry({ claudeSessionId: 'new-sess', shortId: 'deadbeef', pid: 9 })]),
      exec: async () => 'Starting background service…\nbackgrounded · deadbeef · task\n',
    });
    const out = await runner.start({ cwd: '/w/proj', prompt: 'hi', permissionMode: 'plan' }, '/real/w/proj');
    expect(out).toMatchObject({ ok: true, result: { claudeSessionId: 'new-sess', shortId: 'deadbeef' } });
    expect(exec).toHaveBeenCalledWith(['--bg', '--permission-mode', 'plan', '--', 'hi'], expect.objectContaining({ cwd: '/real/w/proj' }));
  });
  it('id bog\'lanmasa correlation_timeout', async () => {
    const { runner } = mk({ entries: () => [], exec: async () => 'backgrounded · deadbeef\n' });
    expect(await runner.start({ cwd: '/w', prompt: 'hi', permissionMode: 'plan' }, '/w')).toMatchObject({ ok: false, code: 'correlation_timeout' });
  });
  it('claude xatosi: claude_failed, xabarda PROMPT yo\'q', async () => {
    const { runner } = mk({ entries: () => [], exec: async () => { throw Object.assign(new Error('Command failed: claude --bg -- SECRET-PROMPT'), { code: 1 }); } });
    const out = await runner.start({ cwd: '/w', prompt: 'SECRET-PROMPT', permissionMode: 'plan' }, '/w');
    expect(out).toMatchObject({ ok: false, code: 'claude_failed' });
    expect(out.message).not.toContain('SECRET-PROMPT');
  });
});

describe('M-19: bg yo\'llarida (start / --resume) ham rejim belgisi rad etiladi', () => {
  it('start: `/x` va `!x` rad, claude chaqirilmaydi', async () => {
    const { runner, exec } = mk({ entries: () => [] });
    for (const prompt of ['/review', '!id', ' /x']) {
      expect(await runner.start({ cwd: '/w', prompt, permissionMode: 'plan' }, '/w')).toMatchObject({ ok: false, code: 'invalid_payload' });
    }
    expect(exec).not.toHaveBeenCalled();
  });
  it('prompt (bg --resume): `/x` rad, claude chaqirilmaydi', async () => {
    const { runner, exec } = mk();
    expect(await runner.prompt({ claudeSessionId: SID, text: '/compact' }, entry())).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('CommandRunner.prompt (stop -> kutish -> bayroqsiz --bg --resume)', () => {
  it('stop, pid yo\'qolguncha kutadi, keyin bayroqsiz resume; xuddi shu id', async () => {
    let polls = 0;
    const calls: string[][] = [];
    const { runner } = mk({
      entries: () => (polls++ < 2 ? [entry()] : [entry({ pid: undefined })]),
      exec: async (args) => {
        calls.push(args);
        return args[0] === 'stop' ? 'stopped a1b97ff9' : 'note: woke session a1b97ff9 with its saved options\nbackgrounded · a1b97ff9 · x\n';
      },
    });
    const out = await runner.prompt({ claudeSessionId: SID, text: 'next' }, entry());
    expect(out).toMatchObject({ ok: true, result: { claudeSessionId: SID, detail: 'stop+resume' } });
    expect(calls).toEqual([['stop', 'a1b97ff9'], ['--bg', '--resume', SID, '--', 'next']]);
  });
  it('pid hech yo\'qolmasa stop_failed va resume CHAQIRILMAYDI (nusxa ochilmasin)', async () => {
    const { runner, exec } = mk({ entries: () => [entry()], exec: async () => 'stopped' });
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry())).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(exec.mock.calls.every((c) => c[0][0] === 'stop')).toBe(true);
  });
  it("supervisor worker'ni qo'yib yubormaguncha --resume chaqirilmaydi", async () => {
    let checks = 0;
    const { runner, exec } = mk({
      holds: () => ++checks <= 3,
      entries: () => [entry({ pid: undefined })],
      exec: async (args) => (args[0] === 'stop' ? 'stopped a1b97ff9' : 'note: woke session a1b97ff9 with its saved options\nbackgrounded · a1b97ff9 · x\n'),
    });
    const out = await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry({ pid: undefined }));
    expect(out).toMatchObject({ ok: true });
    expect(checks).toBe(4);
    expect(exec.mock.calls.some((c) => c[0].includes('--resume'))).toBe(true);
  });
  it("supervisor sessiyani qo'yib yubormasa: stop_failed, --resume chaqirilmaydi", async () => {
    const { runner, exec } = mk({ holds: () => true, entries: () => [entry({ pid: undefined })] });
    const out = await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry({ pid: undefined }));
    expect(out).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(exec.mock.calls.some((c) => c[0].includes('--resume'))).toBe(false);
  });
  it('Claude nusxa ochsa: resume_forked va nusxa to\'xtatiladi', async () => {
    const calls: string[][] = [];
    const { runner } = mk({
      entries: () => [entry({ pid: undefined })],
      exec: async (args) => {
        calls.push(args);
        return args[0] === 'stop' ? 'stopped' : 'note: session a1b97ff9 is already running in the background, so this started a copy as 6c621900.\nbackgrounded · 6c621900\n';
      },
    });
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry({ pid: undefined }))).toMatchObject({ ok: false, code: 'resume_forked' });
    expect(calls.at(-1)).toEqual(['stop', '6c621900']);
  });
  it('terminal (interactive) sessiya: interactive_session, hech narsa ishga tushmaydi', async () => {
    const { runner, exec } = mk();
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry({ kind: 'interactive', shortId: undefined }))).toMatchObject({ ok: false, code: 'interactive_session' });
    expect(exec).not.toHaveBeenCalled();
  });
  it('busy sessiya: session_busy (ishlayotgan ish yo\'qolmasin)', async () => {
    const { runner, exec } = mk();
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, entry({ status: 'busy' }))).toMatchObject({ ok: false, code: 'session_busy' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('CommandRunner.stop / setMode', () => {
  it('bg: claude stop <qisqa id> va pid yo\'qolishi tekshiriladi', async () => {
    let n = 0;
    const { runner, exec } = mk({ entries: () => (n++ < 1 ? [entry()] : [entry({ pid: undefined })]), exec: async () => 'stopped a1b97ff9' });
    expect(await runner.stop({ claudeSessionId: SID }, entry())).toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledWith(['stop', 'a1b97ff9'], expect.anything());
  });
  it('interactive: pid egasi va buyrug\'i tasdiqlansa SIGINT', async () => {
    const signal = vi.fn();
    const { runner } = mk({ procInfo: async () => ({ uid: 501, command: '/Users/x/.local/bin/claude --resume abc' }), signal });
    expect(await runner.stop({ claudeSessionId: SID }, entry({ kind: 'interactive', shortId: undefined, pid: 4321 }))).toMatchObject({ ok: true });
    expect(signal).toHaveBeenCalledWith(4321, 'SIGINT');
  });
  it('interactive: boshqa foydalanuvchi jarayoni yoki claude bo\'lmagan jarayon: not_owned, signal yo\'q', async () => {
    const signal = vi.fn();
    const other = mk({ procInfo: async () => ({ uid: 0, command: 'claude' }), signal });
    expect(await other.runner.stop({ claudeSessionId: SID }, entry({ kind: 'interactive', pid: 1 }))).toMatchObject({ code: 'not_owned' });
    const notClaude = mk({ procInfo: async () => ({ uid: 501, command: '/usr/sbin/sshd -D' }), signal });
    expect(await notClaude.runner.stop({ claudeSessionId: SID }, entry({ kind: 'interactive', pid: 1 }))).toMatchObject({ code: 'not_owned' });
    const gone = mk({ procInfo: async () => null, signal });
    expect(await gone.runner.stop({ claudeSessionId: SID }, entry({ kind: 'interactive', pid: 1 }))).toMatchObject({ code: 'not_owned' });
    expect(signal).not.toHaveBeenCalled();
  });
  it('interactive Windows\'da rad; set_mode doim set_mode_unsupported', async () => {
    const { runner } = mk({ platform: 'win32' });
    expect(await runner.stop({ claudeSessionId: SID }, entry({ kind: 'interactive', pid: 1 }))).toMatchObject({ code: 'interactive_session' });
    expect(runner.setMode({ claudeSessionId: SID, permissionMode: 'plan' })).toMatchObject({ ok: false, code: 'set_mode_unsupported' });
  });
});

describe('CommandRunner: tmux ichidagi terminal sessiya (2.6)', () => {
  const tentry = (over: Partial<AgentEntry> = {}): AgentEntry => entry({ kind: 'interactive', shortId: undefined, pid: 200, status: 'idle', ...over });
  const PS = (fg = 200) => ` 100 1 100 100 501 ttys004\n 200 100 200 ${fg} 501 ttys004\n`;

  function mkTmux(over: { status?: () => string | undefined; fg?: number; panes?: string; localStatus?: string; platform?: string; available?: boolean } = {}) {
    const calls: Array<{ args: string[]; stdin?: string | undefined }> = [];
    const texec: TmuxExec = {
      tmux: async (_s, args, stdin) => {
        calls.push({ args, stdin });
        return args[0] === 'list-panes' ? (over.panes ?? '100 %4 /dev/ttys004 s:0.0\n') : '';
      },
      ps: async () => PS(over.fg),
      available: async () => over.available ?? true,
    };
    const fs = { readdir: () => ['default'], lstat: (p: string) => ({ isSocket: p.endsWith('default'), isDirectory: !p.endsWith('default'), isSymlink: false, uid: 501, mode: 0o700 }) };
    const tmux = new TmuxLocator({ exec: texec, uid: 501, platform: over.platform ?? 'darwin', tmpdirs: () => ['/tmp'], fs, cacheMs: 0 });
    let t = 0;
    const exec = vi.fn(async () => '');
    const runner = new CommandRunner({
      claudeBin: 'claude',
      list: async () => [tentry({ ...(over.status ? { status: over.status() } : {}) })],
      log,
      exec,
      sleep: async (ms) => void (t += ms),
      now: () => t,
      platform: over.platform ?? 'darwin',
      uid: 501,
      tmux,
      ...(over.localStatus ? { localStatus: () => over.localStatus } : {}),
    });
    const sends = () => calls.filter((c) => c.args[0] !== 'list-panes');
    return { runner, calls, sends, exec };
  }

  it('prompt (bir qatorli): idle sessiyaga send-keys -l + Enter; claude CLI chaqirilmaydi', async () => {
    const { runner, sends, exec } = mkTmux();
    expect(await runner.prompt({ claudeSessionId: SID, text: 'salom' }, tentry())).toMatchObject({ ok: true, result: { detail: 'tmux paste' } });
    expect(sends().map((c) => c.args)).toEqual([['send-keys', '-t', '%4', '-l', '--', 'salom'], ['send-keys', '-t', '%4', 'Enter']]);
    expect(exec).not.toHaveBeenCalled();
  });
  it("M-19: `!` va `/` bilan boshlanuvchi prompt (ko'rinmas belgilar/bo'sh joydan keyin ham) RAD ETILADI; tmux'ga hech narsa yuborilmaydi", async () => {
    const { runner, sends } = mkTmux();
    for (const text of ['!rm -rf ~', '/login', '  !ls', '\u200b!ls', '\n/compact', '\ufeff  /help x']) {
      const out = await runner.prompt({ claudeSessionId: SID, text }, tentry());
      expect(out).toMatchObject({ ok: false, code: 'invalid_payload' });
      expect(out.message).toContain('prompt_mode_char');
    }
    expect(sends()).toHaveLength(0);
    // o'rtadagi `!`/`/` va `#` sarlavhasi muammo emas
    expect(await runner.prompt({ claudeSessionId: SID, text: '# Reja\nfix a/b !important' }, tentry())).toMatchObject({ ok: true });
  });
  it('prompt (ko\'p qatorli): bracketed paste rejasi, boshqaruv belgilari tozalangan', async () => {
    const { runner, sends } = mkTmux();
    await runner.prompt({ claudeSessionId: SID, text: 'a\u001b[31m\r\nb' }, tentry());
    const s = sends();
    expect(s[0]?.args.slice(0, 2)).toEqual(['load-buffer', '-b']);
    expect(s[0]?.stdin).toBe('a[31m\nb');
    expect(s[1]?.args.slice(0, 3)).toEqual(['paste-buffer', '-p', '-d']);
    expect(s.filter((c) => c.args.includes('Enter'))).toHaveLength(1);
  });
  it('busy sessiyaga yozilmaydi (session_busy), hech narsa yuborilmaydi', async () => {
    const { runner, sends } = mkTmux({ status: () => 'busy' });
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry({ status: 'idle' }))).toMatchObject({ ok: false, code: 'session_busy' });
    expect(sends()).toHaveLength(0);
  });
  it('ruxsat kutayotgan (awaiting_approval) sessiyaga yozilmaydi', async () => {
    const { runner, sends } = mkTmux({ localStatus: 'awaiting_approval', status: () => 'waiting' });
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry())).toMatchObject({ ok: false, code: 'session_busy' });
    expect(sends()).toHaveLength(0);
  });
  it('oldingi plandagi jarayon claude emas (shell\'ga o\'tilgan): not_owned, hech narsa yuborilmaydi', async () => {
    const { runner, sends } = mkTmux({ fg: 100 });
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry())).toMatchObject({ ok: false, code: 'not_owned' });
    expect(sends()).toHaveLength(0);
  });
  it('pane yo\'q (oddiy terminal) = interactive_session; bo\'sh matn = invalid_payload', async () => {
    const none = mkTmux({ panes: '' });
    expect(await none.runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry())).toMatchObject({ ok: false, code: 'interactive_session' });
    const { runner, sends } = mkTmux();
    expect(await runner.prompt({ claudeSessionId: SID, text: '\u001b\u0000 ' }, tentry())).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(sends()).toHaveLength(0);
  });
  it('juda uzun prompt rad etiladi (jim qisqartirilmaydi)', async () => {
    const { runner, sends } = mkTmux();
    expect(await runner.prompt({ claudeSessionId: SID, text: 'x'.repeat(16_001) }, tentry())).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(sends()).toHaveLength(0);
  });
  it('Windows / tmux o\'rnatilmagan: prompt interactive_session', async () => {
    expect(await mkTmux({ platform: 'win32' }).runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry())).toMatchObject({ code: 'interactive_session' });
    expect(await mkTmux({ available: false }).runner.prompt({ claudeSessionId: SID, text: 'x' }, tentry())).toMatchObject({ code: 'interactive_session' });
  });
  it('stop: ishlayotgan (busy) turnga FAQAT Escape; SIGINT yuborilmaydi', async () => {
    const { runner, sends } = mkTmux({ status: () => 'busy' });
    expect(await runner.stop({ claudeSessionId: SID }, tentry({ status: 'busy' }))).toMatchObject({ ok: true, result: { detail: 'tmux Escape (interrupt turn)' } });
    expect(sends().map((c) => c.args)).toEqual([['send-keys', '-t', '%4', 'Escape']]);
  });
  it('stop: sessiya bo\'sh bo\'lsa hech narsa yuborilmaydi (bo\'sh kiritishda Escape rewind menyusini ochmasin)', async () => {
    const { runner, sends } = mkTmux({ status: () => 'idle' });
    expect(await runner.stop({ claudeSessionId: SID }, tentry())).toMatchObject({ ok: true });
    expect(sends()).toHaveLength(0);
  });
  it('stop: foreground claude emas bo\'lsa not_owned (SIGINT\'ga qaytmaydi)', async () => {
    const signal = vi.fn();
    const m = mkTmux({ fg: 100, status: () => 'busy' });
    expect(await m.runner.stop({ claudeSessionId: SID }, tentry({ status: 'busy' }))).toMatchObject({ ok: false, code: 'not_owned' });
    expect(signal).not.toHaveBeenCalled();
    expect(m.sends()).toHaveLength(0);
  });
  it('hasTmuxPane: faqat interactive + tekshirilgan pane', async () => {
    const m = mkTmux();
    expect(await m.runner.hasTmuxPane(tentry())).toBe(true);
    expect(await m.runner.hasTmuxPane(tentry({ kind: 'bg' }))).toBe(false);
    expect(await m.runner.hasTmuxPane(tentry({ pid: undefined }))).toBe(false);
    expect(await mkTmux({ panes: '' }).runner.hasTmuxPane(tentry())).toBe(false);
  });
});
