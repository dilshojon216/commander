import { describe, expect, it, vi } from 'vitest';
import { TmuxLocator, checkPromptModeChar, findUserSockets, isAncestorOrSelf, matchPane, normalizeTty, parsePanes, parsePs, planInterruptSteps, planPromptSteps, sanitizePromptText } from './tmux.js';
import type { FsEntryStat, PaneRow, ProcRow, SocketFs, TmuxExec } from './tmux.js';

const UID = 501;
const proc = (pid: number, ppid: number, over: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid, pgid: pid, tpgid: pid, uid: UID, tty: 'ttys004', ...over });
const table = (rows: ProcRow[]): Map<number, ProcRow> => new Map(rows.map((r) => [r.pid, r]));
const pane = (over: Partial<PaneRow> = {}): PaneRow => ({ socket: '/tmp/tmux-501/default', panePid: 100, paneId: '%0', paneTty: 'ttys004', label: 's:0.0', ...over });

describe('parsePs / parsePanes', () => {
  it('ps qatorlari va terminalsiz jarayon', () => {
    const m = parsePs('  1     0     1    0     0 ??      \n 200   100   200  200   501 ttys004 \nbad line\n');
    expect(m.get(200)).toEqual({ pid: 200, ppid: 100, pgid: 200, tpgid: 200, uid: 501, tty: 'ttys004' });
    expect(m.get(1)?.tty).toBe('');
    expect(m.size).toBe(2);
  });
  it('pane qatori: label ichida bo\'sh joy bo\'lishi mumkin; /dev/ olib tashlanadi', () => {
    const rows = parsePanes('19616 %0 /dev/ttys004 my session:0.1\ngarbage\n', '/s');
    expect(rows).toEqual([{ socket: '/s', panePid: 19616, paneId: '%0', paneTty: 'ttys004', label: 'my session:0.1' }]);
    expect(normalizeTty('/dev/pts/3')).toBe('pts/3');
  });
});

describe('ajdodlik va moslashtirish', () => {
  // 100 (shell, pane_pid) -> 150 (sh) -> 200 (claude)
  const procs = table([proc(1, 0, { tty: '' }), proc(100, 1), proc(150, 100), proc(200, 150)]);
  it('ajdod zanjiri (tenglik ham), sikl va chuqurlik chegarasi', () => {
    expect(isAncestorOrSelf(procs, 200, 100)).toBe(true);
    expect(isAncestorOrSelf(procs, 200, 200)).toBe(true);
    expect(isAncestorOrSelf(procs, 200, 999)).toBe(false);
    expect(isAncestorOrSelf(table([proc(5, 6), proc(6, 5)]), 5, 99)).toBe(false);
  });
  it('mos pane topiladi; egasi, tty va oldingi plan tekshiriladi', () => {
    expect(matchPane(procs, [pane()], 200, UID)).toEqual({ ok: true, target: { socket: '/tmp/tmux-501/default', paneId: '%0', label: 's:0.0' } });
    expect(matchPane(procs, [pane({ panePid: 999 })], 200, UID)).toEqual({ ok: false, reason: 'no_pane' });
    expect(matchPane(procs, [], 200, UID)).toEqual({ ok: false, reason: 'no_pane' });
    expect(matchPane(procs, [pane()], 777, UID)).toEqual({ ok: false, reason: 'no_pane' });
  });
  it('boshqa foydalanuvchi jarayoni/pane egasi = not_owned', () => {
    expect(matchPane(table([proc(100, 1), proc(200, 100, { uid: 0 })]), [pane()], 200, UID)).toEqual({ ok: false, reason: 'not_owned' });
    expect(matchPane(table([proc(100, 1, { uid: 0 }), proc(200, 100)]), [pane()], 200, UID)).toEqual({ ok: false, reason: 'not_owned' });
  });
  it('oldingi plan claude emas (foydalanuvchi shell\'ga o\'tgan) yoki tty boshqa = not_foreground', () => {
    const back = table([proc(100, 1), proc(200, 100, { tpgid: 100 })]);
    expect(matchPane(back, [pane()], 200, UID)).toEqual({ ok: false, reason: 'not_foreground' });
    expect(matchPane(table([proc(100, 1), proc(200, 100, { tty: 'ttys009' })]), [pane()], 200, UID)).toEqual({ ok: false, reason: 'not_foreground' });
    expect(matchPane(table([proc(100, 1), proc(200, 100, { tty: '', tpgid: 0 })]), [pane()], 200, UID)).toEqual({ ok: false, reason: 'not_foreground' });
  });
  it('ichma-ich tmux: eng yaqin ajdod pane tanlanadi', () => {
    const nested = table([proc(10, 1), proc(100, 10), proc(200, 100)]);
    const r = matchPane(nested, [pane({ panePid: 10, paneId: '%9' }), pane({ panePid: 100, paneId: '%1' })], 200, UID);
    expect(r).toMatchObject({ ok: true, target: { paneId: '%1' } });
  });
});

describe('soket egaligi filtri', () => {
  const st = (over: Partial<FsEntryStat> = {}): FsEntryStat => ({ isSocket: false, isDirectory: false, isSymlink: false, uid: UID, mode: 0o700, ...over });
  const mkFs = (tree: Record<string, FsEntryStat>, dirs: Record<string, string[]>): SocketFs => ({ readdir: (d) => dirs[d] ?? [], lstat: (p) => tree[p] });
  it('faqat tmux-<uid> ichidagi o\'z soketlari; boshqa uid katalogi, ochiq katalog, symlink va noto\'g\'ri egali soket tashlanadi', () => {
    const fs = mkFs(
      {
        '/tmp/tmux-501': st({ isDirectory: true }),
        '/tmp/tmux-501/default': st({ isSocket: true }),
        '/tmp/tmux-501/other': st({ isSocket: true }),
        '/tmp/tmux-501/evil': st({ isSocket: true, uid: 0 }),
        '/tmp/tmux-501/link': st({ isSocket: true, isSymlink: true }),
        '/tmp/tmux-501/file': st(),
        '/x/tmux-501': st({ isDirectory: true, mode: 0o755 }),
        '/x/tmux-501/default': st({ isSocket: true }),
        '/y/tmux-501': st({ isDirectory: true, uid: 0 }),
        '/y/tmux-501/default': st({ isSocket: true }),
      },
      { '/tmp/tmux-501': ['other', 'default', 'evil', 'link', 'file'], '/x/tmux-501': ['default'], '/y/tmux-501': ['default'] },
    );
    expect(findUserSockets(UID, ['', '/tmp', '/x', '/y', '/tmp'], fs)).toEqual(['/tmp/tmux-501/default', '/tmp/tmux-501/other']);
    expect(findUserSockets(UID, ['/tmp'], mkFs({}, {}))).toEqual([]);
  });
});

describe('matn tozalash', () => {
  it('boshqaruv belgilari (ESC, NUL, DEL, C1) olib tashlanadi; \\n saqlanadi; CRLF -> \\n; tab -> bo\'sh joy', () => {
    expect(sanitizePromptText('a\u001b[201~b\u0000c\u007fd\u0085e')).toBe('a[201~bcde');
    expect(sanitizePromptText('x\r\ny\rz w')).toBe('x\ny\nz\nw');
    expect(sanitizePromptText('a\tb')).toBe('a b');
    expect(sanitizePromptText('line1\n\n\n\n\nline2')).toBe('line1\n\nline2');
  });
  it('bo\'sh/faqat boshqaruv belgilari = null; uzunlik cheklanadi', () => {
    expect(sanitizePromptText('  \u001b\n ')).toBeNull();
    expect(sanitizePromptText('x'.repeat(20_000))?.length).toBe(20_000); // qisqartirmaydi: chaqiruvchi TMUX_PROMPT_MAX bilan rad etadi
  });
  it('tirnoq/shell belgilari o\'zgarmaydi (shell yo\'q)', () => {
    expect(sanitizePromptText('$(id) `x` "q" \'s\' ; | &')).toBe('$(id) `x` "q" \'s\' ; | &');
  });
});

describe('yuborish rejalari (argument massivlari)', () => {
  it('bir qatorli: send-keys -l -- <matn>, keyin Enter (matn bayroq bo\'la olmaydi)', () => {
    expect(planPromptSteps('%3', '-x --help', 'b')).toEqual([
      { args: ['send-keys', '-t', '%3', '-l', '--', '-x --help'] },
      { args: ['send-keys', '-t', '%3', 'Enter'] },
    ]);
  });
  it('ko\'p qatorli: load-buffer - (stdin) + paste-buffer -p -d + bitta Enter; matn argumentda YO\'Q', () => {
    const steps = planPromptSteps('%3', 'a\nb', 'cmdr-1');
    expect(steps).toEqual([
      { args: ['load-buffer', '-b', 'cmdr-1', '-'], stdin: 'a\nb' },
      { args: ['paste-buffer', '-p', '-d', '-b', 'cmdr-1', '-t', '%3'] },
      { args: ['send-keys', '-t', '%3', 'Enter'] },
    ]);
    expect(steps.filter((s) => s.args.includes('Enter'))).toHaveLength(1);
    expect(JSON.stringify(steps.map((s) => s.args))).not.toContain('a\\nb');
  });
  it('stop = faqat Escape (C-c YO\'Q: ikki marta bosilsa chiqib ketadi)', () => {
    expect(planInterruptSteps('%3')).toEqual([{ args: ['send-keys', '-t', '%3', 'Escape'] }]);
  });
});

describe('TmuxLocator', () => {
  const procs = ' 100 1 100 100 501 ttys004\n 200 100 200 200 501 ttys004\n';
  const fs: SocketFs = { readdir: () => ['default'], lstat: (p) => (p.endsWith('default') ? { isSocket: true, isDirectory: false, isSymlink: false, uid: UID, mode: 0o700 } : { isSocket: false, isDirectory: true, isSymlink: false, uid: UID, mode: 0o700 }) };
  const mk = (over: Partial<TmuxExec> = {}, platform = 'darwin') => {
    const calls: Array<{ socket: string; args: string[]; stdin?: string | undefined }> = [];
    const exec: TmuxExec = {
      tmux: vi.fn(async (socket, args, stdin) => {
        calls.push({ socket, args, stdin });
        return args[0] === 'list-panes' ? '100 %0 /dev/ttys004 s:0.0\n' : '';
      }),
      ps: vi.fn(async () => procs),
      available: vi.fn(async () => true),
      ...over,
    };
    let t = 0;
    const loc = new TmuxLocator({ exec, uid: UID, platform, tmpdirs: () => ['/tmp'], fs, now: () => t, cacheMs: 5000 });
    return { loc, exec, calls, advance: (ms: number) => (t += ms) };
  };
  it('topadi; keshlaydi, lekin fresh=true har safar qayta o\'qiydi', async () => {
    const { loc, exec, advance } = mk();
    expect((await loc.locate(200)).ok).toBe(true);
    await loc.locate(200);
    expect(exec.ps).toHaveBeenCalledTimes(1);
    await loc.locate(200, { fresh: true });
    expect(exec.ps).toHaveBeenCalledTimes(2);
    advance(6000);
    await loc.locate(200);
    expect(exec.ps).toHaveBeenCalledTimes(3);
  });
  it('tmux o\'rnatilmagan yoki Windows: hech narsa ishga tushmaydi', async () => {
    const none = mk({ available: vi.fn(async () => false) });
    expect(await none.loc.locate(200)).toEqual({ ok: false, reason: 'no_pane' });
    expect(await none.loc.isAvailable()).toBe(false);
    expect(none.exec.tmux).not.toHaveBeenCalled();
    const win = mk({}, 'win32');
    expect(await win.loc.isAvailable()).toBe(false);
    expect((await win.loc.locateMany([200])).size).toBe(0);
    expect(win.exec.available).not.toHaveBeenCalled();
  });
  it('o\'lik soket (tmux xato) tashlab ketiladi', async () => {
    const { loc } = mk({ tmux: vi.fn(async () => { throw new Error('no server'); }) });
    expect(await loc.locate(200)).toEqual({ ok: false, reason: 'no_pane' });
  });
  it('run: bosqichlar ketma-ket, stdin faqat load-buffer\'ga; xatoda bufer o\'chiriladi', async () => {
    const { loc, calls } = mk();
    const sleep = vi.fn(async () => undefined);
    await loc.run({ socket: '/s', paneId: '%0', label: 'x' }, planPromptSteps('%0', 'a\nb', 'cmdr-9'), sleep);
    expect(calls.map((c) => c.args[0])).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
    expect(calls[0]?.stdin).toBe('a\nb');
    expect(calls[1]?.stdin).toBeUndefined();

    const failing = mk({ tmux: vi.fn(async (_s, args) => { if (args[0] === 'paste-buffer') throw new Error('boom'); return ''; }) });
    await expect(failing.loc.run({ socket: '/s', paneId: '%0', label: 'x' }, planPromptSteps('%0', 'a\nb', 'cmdr-9'), sleep)).rejects.toThrow('boom');
    expect(failing.exec.tmux).toHaveBeenLastCalledWith('/s', ['delete-buffer', '-b', 'cmdr-9']);
  });
});

describe('M-19: checkPromptModeChar', () => {
  it('`!` va `/` birinchi ko\'rinadigan belgi bo\'lsa xato; `allowSlashCommand` faqat `/` ni ochadi', () => {
    expect(checkPromptModeChar('!ls')).toContain('prompt_mode_char');
    expect(checkPromptModeChar('/help')).toContain('prompt_mode_char');
    expect(checkPromptModeChar('\u200d\u202e !x')).toContain('prompt_mode_char');
    expect(checkPromptModeChar('/remote-control x', { allowSlashCommand: true })).toBeNull();
    expect(checkPromptModeChar('!ls', { allowSlashCommand: true })).toContain('prompt_mode_char');
  });
  it('oddiy matn, markdown sarlavha va o\'rtadagi belgilar o\'tadi', () => {
    for (const t of ['hello', '# Title', 'run /help', 'wow! ok', 'a\n!b', '', '   ']) expect(checkPromptModeChar(t)).toBeNull();
  });
});
