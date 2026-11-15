import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PolicySchema, checkCwd, decidePolicy, isInside, isInsideSensitive, loadPolicy, runPolicyCli, sensitiveDirs, validateRootToAdd } from './policy.js';
import type { PathOps } from './policy.js';

const posix = process.platform !== 'win32';
let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cmdr-policy-'));
  root = path.join(dir, 'allowed');
  outside = path.join(dir, 'outside');
  mkdirSync(path.join(root, 'proj', 'sub'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enabled = (extra: Record<string, unknown> = {}) => PolicySchema.parse({ remote: { enabled: true, allowedRoots: [root], ...extra } });

describe('isInside (sof, Windows semantikasi bilan)', () => {
  it('POSIX: ichida, tenglik, tashqarida, ".." prefiksli nomlar', () => {
    expect(isInside('/a/b', '/a/b/c', path.posix)).toBe(true);
    expect(isInside('/a/b', '/a/b', path.posix)).toBe(true);
    expect(isInside('/a/b', '/a/bc', path.posix)).toBe(false);
    expect(isInside('/a/b', '/a', path.posix)).toBe(false);
    expect(isInside('/a/b', '/a/b/../c', path.posix)).toBe(false);
    expect(isInside('/a/b', '/a/b/..x/y', path.posix)).toBe(true); // "..x" oddiy papka nomi
  });
  it('Windows: registrga befarq, boshqa disk tashqarida, UNC', () => {
    expect(isInside('C:\\Users\\x\\proj', 'c:\\users\\X\\Proj\\sub', path.win32, true)).toBe(true);
    expect(isInside('C:\\Users\\x\\proj', 'D:\\Users\\x\\proj', path.win32, true)).toBe(false);
    expect(isInside('C:\\Users\\x\\proj', 'C:\\Users\\x\\proj2', path.win32, true)).toBe(false);
    expect(isInside('C:\\Users\\x\\proj', 'C:\\Users\\x\\proj\\..\\other', path.win32, true)).toBe(false);
    expect(isInside('\\\\srv\\share\\p', '\\\\srv\\share\\p\\a', path.win32, true)).toBe(true);
    expect(isInside('\\\\srv\\share\\p', '\\\\other\\share\\p\\a', path.win32, true)).toBe(false);
  });
});

describe('checkCwd (haqiqiy fayl tizimi)', () => {
  const none: string[] = [];
  it('ildiz ichidagi papka o\'tadi (realpath qaytariladi)', () => {
    const r = checkCwd(path.join(root, 'proj'), [root], undefined, none);
    expect(r.ok).toBe(true);
  });
  it('ildizning o\'zi o\'tadi; tashqi papka cwd_not_allowed', () => {
    expect(checkCwd(root, [root], undefined, none).ok).toBe(true);
    expect(checkCwd(outside, [root], undefined, none)).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });
  it('".." bilan chiqish rad etiladi', () => {
    expect(checkCwd(path.join(root, 'proj', '..', '..', 'outside'), [root], undefined, none)).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });
  it.skipIf(!posix)('ildiz ichidagi symlink tashqariga olib chiqsa rad etiladi', () => {
    symlinkSync(outside, path.join(root, 'escape'));
    expect(checkCwd(path.join(root, 'escape'), [root], undefined, none)).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });
  it.skipIf(!posix)('ildizning o\'zi symlink bo\'lsa realpath bilan solishtiriladi (ichki papka o\'tadi)', () => {
    const link = path.join(dir, 'rootlink');
    symlinkSync(root, link);
    expect(checkCwd(path.join(root, 'proj'), [link], undefined, none).ok).toBe(true);
    expect(checkCwd(path.join(link, 'proj'), [root], undefined, none).ok).toBe(true);
  });
  it('mavjud bo\'lmagan, nisbiy, fayl, NUL bilan: cwd_invalid', () => {
    expect(checkCwd(path.join(root, 'nope'), [root], undefined, none)).toMatchObject({ code: 'cwd_invalid' });
    expect(checkCwd('relative/dir', [root], undefined, none)).toMatchObject({ code: 'cwd_invalid' });
    writeFileSync(path.join(root, 'file.txt'), 'x');
    expect(checkCwd(path.join(root, 'file.txt'), [root], undefined, none)).toMatchObject({ code: 'cwd_invalid' });
    expect(checkCwd(`${root}\0/x`, [root], undefined, none)).toMatchObject({ code: 'cwd_invalid' });
  });
  it('maxfiy papka (~/.ssh o\'xshash) ildiz ichida bo\'lsa ham rad etiladi', () => {
    const ssh = path.join(root, '.ssh');
    mkdirSync(ssh);
    expect(checkCwd(ssh, [root], undefined, [ssh])).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
    expect(checkCwd(path.join(root, 'proj'), [root], undefined, [ssh]).ok).toBe(true);
  });
  it('Windows ops (soxta): disk harfi/registr farqi', () => {
    const win: PathOps = {
      realpath: (p) => p.replace(/^c:/i, 'C:'),
      isDirectory: () => true,
      lib: path.win32,
      caseInsensitive: true,
    };
    expect(checkCwd('c:\\Work\\Proj', ['C:\\work'], win, []).ok).toBe(true);
    expect(checkCwd('D:\\Work\\Proj', ['C:\\work'], win, [])).toMatchObject({ code: 'cwd_not_allowed' });
    expect(checkCwd('C:\\workshop', ['C:\\work'], win, [])).toMatchObject({ code: 'cwd_not_allowed' });
  });
});

describe('validateRootToAdd', () => {
  it('fayl tizimi ildizi, $HOME, mavjud bo\'lmagan, nisbiy rad etiladi; oddiy papka o\'tadi', () => {
    expect(validateRootToAdd(path.parse(dir).root)).toMatchObject({ ok: false });
    expect(validateRootToAdd(dir, undefined, dir)).toMatchObject({ ok: false });
    expect(validateRootToAdd(path.join(dir, 'nope'))).toMatchObject({ ok: false });
    expect(validateRootToAdd('rel')).toMatchObject({ ok: false });
    expect(validateRootToAdd(root)).toMatchObject({ ok: true });
  });
});

describe('decidePolicy', () => {
  const base = { runningAsRoot: false, sensitive: [] as string[] };
  it('DEFAULT siyosat: hammasi rad (policy_disabled)', () => {
    const p = PolicySchema.parse({});
    for (const type of ['session.start', 'session.prompt', 'session.stop', 'session.set_mode'] as const) {
      expect(decidePolicy({ ...base, type, policy: p, cwd: root })).toMatchObject({ ok: false, code: 'policy_disabled' });
    }
  });
  it('root bilan ishlaganda hamma narsa rad etiladi', () => {
    expect(decidePolicy({ ...base, runningAsRoot: true, type: 'session.stop', policy: enabled() })).toMatchObject({ code: 'running_as_root' });
  });
  it('allow bayroqlari', () => {
    expect(decidePolicy({ ...base, type: 'session.stop', policy: enabled({ allowStop: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled({ allowStart: false }), cwd: root })).toMatchObject({ code: 'action_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.stop', policy: enabled() }).ok).toBe(true); // stop ildizga bog'liq emas
  });
  it('bypassPermissions / dontAsk HECH QACHON (siyosat nima bo\'lmasin)', () => {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      expect(decidePolicy({ ...base, type: 'session.start', policy: enabled({ allowAutoMode: true }), cwd: root, permissionMode: mode })).toMatchObject({ code: 'mode_forbidden' });
    }
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled(), cwd: root, permissionMode: 'weird' })).toMatchObject({ code: 'mode_forbidden' });
  });
  it('auto faqat allowAutoMode bilan', () => {
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled(), cwd: root, permissionMode: 'auto' })).toMatchObject({ code: 'mode_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled({ allowAutoMode: true }), cwd: root, permissionMode: 'auto' }).ok).toBe(true);
  });
  it('start: ildizdan tashqari cwd rad, ildiz ichidagi o\'tadi va realpath qaytadi; maxConcurrentStarted', () => {
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled(), cwd: outside, permissionMode: 'plan' })).toMatchObject({ code: 'cwd_not_allowed' });
    const ok = decidePolicy({ ...base, type: 'session.start', policy: enabled(), cwd: path.join(root, 'proj'), permissionMode: 'plan', liveStarted: 2 });
    expect(ok).toMatchObject({ ok: true });
    expect(decidePolicy({ ...base, type: 'session.start', policy: enabled({ maxConcurrentStarted: 2 }), cwd: root, permissionMode: 'plan', liveStarted: 2 })).toMatchObject({ code: 'too_many_sessions' });
  });
  it('prompt: sessiya cwd\'si ildiz ichida bo\'lishi shart', () => {
    expect(decidePolicy({ ...base, type: 'session.prompt', policy: enabled(), cwd: outside })).toMatchObject({ code: 'cwd_not_allowed' });
    expect(decidePolicy({ ...base, type: 'session.prompt', policy: enabled(), cwd: path.join(root, 'proj') }).ok).toBe(true);
  });
});

describe.skipIf(!posix)('policy.json yuklash (0600) va CLI', () => {
  const paths = () => ({ home: dir, policyFile: path.join(dir, 'policy.json') });
  it('fayl yo\'q = default (o\'chiq)', () => {
    expect(loadPolicy(paths())).toMatchObject({ source: 'default' });
    expect(loadPolicy(paths()).policy.remote.enabled).toBe(false);
  });
  it('guruh/boshqalarga ochiq fayl rad etiladi (fail-closed)', () => {
    writeFileSync(paths().policyFile, JSON.stringify({ remote: { enabled: true, allowedRoots: [root] } }), { mode: 0o644 });
    chmodSync(paths().policyFile, 0o644);
    const l = loadPolicy(paths());
    expect(l.source).toBe('insecure');
    expect(l.policy.remote.enabled).toBe(false);
  });
  it('buzuq JSON yoki noto\'g\'ri tur: o\'chiq', () => {
    writeFileSync(paths().policyFile, '{not json', { mode: 0o600 });
    expect(loadPolicy(paths()).source).toBe('invalid');
    writeFileSync(paths().policyFile, JSON.stringify({ remote: { enabled: 'yes' } }), { mode: 0o600 });
    expect(loadPolicy(paths()).source).toBe('invalid');
  });
  it('symlink bo\'lgan policy.json rad etiladi', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ remote: { enabled: true } }), { mode: 0o600 });
    symlinkSync(real, paths().policyFile);
    expect(loadPolicy(paths()).source).toBe('insecure');
  });
  it('CLI: enable/allow-root/disable/remove-root, fayl 0600 va ildizlar realpath', () => {
    const out: string[] = [];
    const run = (...a: string[]) => runPolicyCli({ ...paths(), keyFile: '', dbFile: '', configFile: '', socketFile: '', otlpTokenFile: '' }, a, (s) => out.push(s), (s) => out.push(`ERR ${s}`));
    expect(run('allow-root', path.join(root, 'proj'))).toBe(0);
    expect(run('enable')).toBe(0);
    const l = loadPolicy(paths());
    expect(l.source).toBe('file');
    expect(l.policy.remote.enabled).toBe(true);
    expect(l.policy.remote.allowedRoots).toHaveLength(1);
    expect(run('allow-root', path.parse(dir).root)).toBe(2);
    expect(run('remove-root', path.join(root, 'proj'))).toBe(0);
    expect(loadPolicy(paths()).policy.remote.allowedRoots).toEqual([]);
    expect(run('disable')).toBe(0);
    expect(loadPolicy(paths()).policy.remote.enabled).toBe(false);
    expect(run('bogus')).toBe(2);
  });
  it('CLI: allow-scan/deny-scan (6.10)', () => {
    const out: string[] = [];
    const run = (...a: string[]) => runPolicyCli({ ...paths(), keyFile: '', dbFile: '', configFile: '', socketFile: '', otlpTokenFile: '' }, a, (s) => out.push(s), (s) => out.push(`ERR ${s}`));
    expect(run('deny-scan')).toBe(0);
    expect(loadPolicy(paths()).policy.remote.allowScan).toBe(false);
    expect(out.join('')).toContain('remote.allowScan:         false');
    expect(run('allow-scan')).toBe(0);
    expect(loadPolicy(paths()).policy.remote.allowScan).toBe(true);
  });
});

describe('decidePolicy: project.scan (6.10)', () => {
  const base = { runningAsRoot: false };
  it('allowScan default true; o\'z bayrog\'i bilan boshqariladi, allowProjectRead bog\'liq emas', () => {
    expect(PolicySchema.parse({}).remote.allowScan).toBe(true);
    expect(decidePolicy({ ...base, policy: enabled({ allowProjectRead: false }), type: 'project.scan', cwd: root }).ok).toBe(true);
    const off = decidePolicy({ ...base, policy: enabled({ allowScan: false }), type: 'project.scan', cwd: root });
    expect(off).toMatchObject({ ok: false, code: 'action_not_allowed' });
  });
  it('ildiz tekshiruvi saqlanadi', () => {
    expect(decidePolicy({ ...base, policy: enabled(), type: 'project.scan', cwd: path.parse(root).root })).toMatchObject({ ok: false });
  });
});

describe('allow-home: $HOME ildiz (egasi qarori 2026-11-14)', () => {
  let home: string;
  const pp = () => ({ home: dir, policyFile: path.join(dir, 'policy.json'), keyFile: '', dbFile: '', configFile: '', socketFile: '', otlpTokenFile: '' });
  const mkHome = (): string => {
    const h = path.join(dir, 'home');
    for (const d of ['.ssh/keys', '.gnupg', '.aws', '.claude/projects', '.commander', '.config/commander', '.config/other', 'work/app', 'misc']) mkdirSync(path.join(h, d), { recursive: true });
    return realpathSync(h);
  };

  it('allow-root <$HOME> rad (xabar allow-home ni ko\'rsatadi); allow-home qo\'shadi; deny-home olib tashlaydi; "/" doim rad', () => {
    home = mkHome();
    const out: string[] = [];
    const run = (...a: string[]) => runPolicyCli(pp(), a, (x) => out.push(x), (x) => out.push(`ERR ${x}`), undefined, home);
    expect(run('allow-root', home)).toBe(2);
    expect(out.join('')).toContain('allow-home');
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([]);
    out.length = 0;
    expect(run('allow-home')).toBe(0);
    const text = out.join('');
    expect(text).toContain('OGOHLANTIRISH');
    for (const d of ['.ssh', '.gnupg', '.aws', '.claude', '.commander']) expect(text).toContain(d);
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([home]);
    expect(run('allow-home')).toBe(0); // takror qo'shilmaydi
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([home]);
    expect(run('deny-home')).toBe(0);
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([]);
    // fayl tizimi ildizi: allow-root ham, HOME=/ bilan allow-home ham rad
    expect(run('allow-root', path.parse(dir).root)).toBe(2);
    expect(run('allow-home')).toBe(0);
    expect(runPolicyCli(pp(), ['allow-home'], () => undefined, () => undefined, undefined, path.parse(dir).root)).toBe(2);
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([home]);
  });

  it('allow-home mavjud bo\'lmagan home\'da rad; deny-home boshqa ildizlarga tegmaydi; log-root uchun $HOME rad', () => {
    home = mkHome();
    const run = (...a: string[]) => runPolicyCli(pp(), a, () => undefined, () => undefined, undefined, home);
    expect(runPolicyCli(pp(), ['allow-home'], () => undefined, () => undefined, undefined, path.join(dir, 'yoq'))).toBe(2);
    expect(run('allow-root', path.join(home, 'work'))).toBe(0);
    expect(run('allow-home')).toBe(0);
    expect(run('deny-home')).toBe(0);
    expect(loadPolicy(pp()).policy.remote.allowedRoots).toEqual([path.join(home, 'work')]);
    expect(run('allow-log-root', home)).toBe(2);
    expect(loadPolicy(pp()).policy.remote.allowedLogRoots).toEqual([]);
  });

  it('validateRootToAdd: $HOME code=home, boshqalari kodsiz', () => {
    home = mkHome();
    expect(validateRootToAdd(home, undefined, home)).toMatchObject({ ok: false, code: 'home' });
    expect(validateRootToAdd(path.join(home, 'work'), undefined, home).ok).toBe(true);
    expect(validateRootToAdd(path.parse(dir).root, undefined, home)).toMatchObject({ ok: false });
  });

  it('$HOME ildiz bo\'lganda: .ssh/.claude/.commander/.aws/.gnupg/.config/commander va ichki papkalar cwd_not_allowed', () => {
    home = mkHome();
    const sens = sensitiveDirs(home);
    const policy = enabled({ allowedRoots: [home], allowDeploy: true });
    const base = { runningAsRoot: false, policy, sensitive: sens };
    for (const d of ['.ssh', '.ssh/keys', '.gnupg', '.aws', '.claude', '.claude/projects', '.commander', '.config/commander']) {
      for (const type of ['session.start', 'session.prompt', 'project.read_md', 'project.scan', 'deploy.run', 'git.checkpoint'] as const) {
        const r = decidePolicy({ ...base, type, cwd: path.join(home, d) });
        expect(r, `${type} ${d}`).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
      }
    }
    // $HOME o'zi va boshqa hamma narsa ok
    for (const d of ['', 'work', 'work/app', 'misc', '.config/other']) {
      expect(decidePolicy({ ...base, type: 'session.start', cwd: path.join(home, d) }), d).toMatchObject({ ok: true });
    }
  });

  it('symlink orqali maxfiy papkaga kirish ham rad (realpath)', () => {
    if (!posix) return;
    home = mkHome();
    symlinkSync(path.join(home, '.ssh'), path.join(home, 'work', 'sneaky'));
    const c = checkCwd(path.join(home, 'work', 'sneaky'), [home], undefined, sensitiveDirs(home));
    expect(c).toMatchObject({ ok: false, code: 'cwd_not_allowed' });
  });

  it('sensitiveDirs: agentd holati (~/.config/commander, COMMANDER_HOME) kiradi; isInsideSensitive', () => {
    home = mkHome();
    const s = sensitiveDirs(home, undefined, { COMMANDER_HOME: path.join(dir, 'custom-state') });
    expect(s).toContain(path.join(home, '.config', 'commander'));
    expect(s).toContain(path.join(home, '.commander'));
    expect(s).toContain(path.join(dir, 'custom-state'));
    expect(isInsideSensitive(path.join(home, '.aws', 'x'), undefined, s)).toBe(true);
    expect(isInsideSensitive(path.join(home, 'work'), undefined, s)).toBe(false);
    expect(isInsideSensitive(path.join(home, '.awsome'), undefined, s)).toBe(false);
  });
});
