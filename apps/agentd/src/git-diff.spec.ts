import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_OPS_LIMITS } from '@commander/contracts';
import { assembleFiles, buildDiffArgs, capBytes, collectDiff, isSecretPath, mergeStats, parseNameStatus, parseNumstat, resolveBase, splitPatchBlocks } from './git-diff.js';
import type { GitRunner } from './git-info.js';

describe('buildDiffArgs: shell yo\'q, xavfsiz bayroqlar', () => {
  it('pager/tashqi diff/rang o\'chirilgan, sha oxirida, `--` bilan tugaydi', () => {
    const sha = 'a'.repeat(40);
    for (const mode of ['numstat', 'name-status', 'patch'] as const) {
      const a = buildDiffArgs(mode, sha);
      expect(a.slice(0, 6)).toEqual(['-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.quotepath=off']);
      expect(a).toContain('--no-ext-diff');
      expect(a).toContain('--no-textconv');
      expect(a).toContain('--no-color');
      expect(a[a.length - 2]).toBe(sha);
      expect(a[a.length - 1]).toBe('--');
      expect(a.some((x) => /[;|&$`\n]/.test(x))).toBe(false);
    }
  });
  it('hex bo\'lmagan bazani rad etadi (bayroq inyeksiyasi)', () => {
    for (const bad of ['--output=/tmp/x', '-p', 'HEAD', 'main', '', 'zzzzzzz']) expect(() => buildDiffArgs('patch', bad)).toThrow();
  });
});

describe('parserlar', () => {
  it('name-status -z (rename bilan)', () => {
    const out = 'M\0src/a.ts\0A\0b.txt\0R100\0old name.ts\0new name.ts\0D\0gone\0T\0t\0';
    expect(parseNameStatus(out)).toEqual([
      { status: 'modified', path: 'src/a.ts', oldPath: null },
      { status: 'added', path: 'b.txt', oldPath: null },
      { status: 'renamed', path: 'new name.ts', oldPath: 'old name.ts' },
      { status: 'deleted', path: 'gone', oldPath: null },
      { status: 'typechange', path: 't', oldPath: null },
    ]);
  });
  it('numstat -z (binar va rename)', () => {
    const out = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '0\t0\t', 'old', 'new', ''].join('\0');
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'img.png', additions: null, deletions: null, binary: true },
      { path: 'new', additions: 0, deletions: 0, binary: false },
    ]);
  });
  it('mergeStats yo\'l bo\'yicha birlashtiradi', () => {
    const s = mergeStats(parseNameStatus('M\0a\0'), parseNumstat('2\t5\ta\0'));
    expect(s).toEqual([{ path: 'a', oldPath: null, status: 'modified', additions: 2, deletions: 5, binary: false }]);
  });
  it('splitPatchBlocks', () => {
    const p = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\nnew file mode 100644\n';
    const b = splitPatchBlocks(p);
    expect(b).toHaveLength(2);
    expect(b[0]).toContain('+b');
    expect(b[1]!.startsWith('diff --git a/y')).toBe(true);
    expect(splitPatchBlocks('')).toEqual([]);
  });
});

describe('maxfiy fayllar', () => {
  it('aniqlash', () => {
    for (const s of ['.env', '.env.local', 'app/.env.production', 'id_rsa', 'keys/server.pem', 'x/.ssh/config', 'credentials.json', 'a/service-account-prod.json', '.npmrc', 'cert.p12']) expect(isSecretPath(s), s).toBe(true);
    for (const s of ['.env.example', 'src/env.ts', 'README.md', 'src/secrets-manager.ts', 'keyboard.ts', 'a/b/index.ts']) expect(isSecretPath(s), s).toBe(false);
  });
});

describe('capBytes va assembleFiles', () => {
  it('qator chegarasida kesadi', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const r = capBytes(text, 50);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThan(120);
    expect(capBytes('short', 50)).toEqual({ text: 'short', truncated: false });
  });
  const stat = (path: string, extra: Partial<Parameters<typeof assembleFiles>[0][number]> = {}) => ({ path, oldPath: null, status: 'modified' as const, additions: 1, deletions: 0, binary: false, ...extra });
  it('redakt, maxfiy/binar yashirin, byudjet', () => {
    const blocks = ['diff --git a/a b/a\n+API_KEY=sk-ant-abcdefghijklmnop\n+ok', 'diff --git a/.env b/.env\n+SECRET=1', 'x', 'diff --git a/c b/c\n+' + 'z'.repeat(5000)];
    const r = assembleFiles([stat('a'), stat('.env'), stat('img.png', { binary: true, additions: null, deletions: null }), stat('c')], blocks, { maxBytes: 1000, statOnly: false });
    expect(r.files[0]!.patch).not.toContain('sk-ant-abcdefghijklmnop');
    expect(r.files[0]!.patch).toContain('+ok');
    expect(r.files[1]).toMatchObject({ patch: null, hidden: 'secret' });
    expect(r.files[2]).toMatchObject({ patch: null, hidden: 'binary' });
    expect(r.files[3]!.truncated).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(1100);
  });
  it('byudjet tugagach keyingi fayllar patch\'siz', () => {
    const big = 'diff --git a/a b/a\n+' + 'q\n+'.repeat(400);
    const r = assembleFiles([stat('a'), stat('b')], [big, big], { maxBytes: 300, statOnly: false });
    expect(r.files[1]).toMatchObject({ patch: null, hidden: 'budget', truncated: true });
  });
  it('statOnly: hech qanday patch', () => {
    const r = assembleFiles([stat('a')], ['diff --git a/a b/a\n+x'], { maxBytes: 1000, statOnly: true });
    expect(r.files[0]).toMatchObject({ patch: null, hidden: 'stat_only' });
  });
  it('fayllar soni chegaralanadi', () => {
    const many = Array.from({ length: GIT_OPS_LIMITS.maxFiles + 5 }, (_, i) => stat(`f${i}`));
    const r = assembleFiles(many, [], { maxBytes: 1000, statOnly: true });
    expect(r.files).toHaveLength(GIT_OPS_LIMITS.maxFiles);
    expect(r.truncated).toBe(true);
  });
});

describe('resolveBase (soxta git)', () => {
  const sha = 'b'.repeat(40);
  it('HEAD, sha, merge-base (origin zaxirasi)', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (_c, args) => {
      calls.push([...args]);
      if (args[0] === 'merge-base' && args[2] === 'main') throw new Error('no main');
      return `${sha}\n`;
    };
    expect(await resolveBase('/r', 'HEAD', git)).toBe(sha);
    expect(await resolveBase('/r', 'abc1234', git)).toBe(sha);
    expect(calls[1]).toEqual(['rev-parse', '--verify', '--quiet', 'abc1234^{commit}']);
    expect(await resolveBase('/r', 'merge-base:main', git)).toBe(sha);
    expect(calls[calls.length - 1]).toEqual(['merge-base', 'HEAD', 'origin/main']);
    expect(await resolveBase('/r', 'weird', git)).toBeNull();
    const bad: GitRunner = async () => {
      throw new Error('x');
    };
    expect(await resolveBase('/r', 'HEAD', bad)).toBeNull();
  });
});

describe('collectDiff (haqiqiy git, vaqtinchalik repo)', () => {
  let dir = '';
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  let first = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-diff-')));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, '.env'), 'X=1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    first = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nTOKEN=abc123secretvalue\n');
    writeFileSync(join(dir, '.env'), 'X=2\nSECRET=hunter2\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git('add', 'bin.dat');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'untracked.txt'), 'new file contents never shown');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('fayllar, +/-, redakt, maxfiy va binar yashirin, untracked faqat nom', async () => {
    const r = await collectDiff(dir, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.result.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 0, hidden: null });
    expect(byPath.get('a.txt')!.patch).toContain('+three');
    expect(byPath.get('a.txt')!.patch).not.toContain('abc123secretvalue');
    expect(byPath.get('.env')).toMatchObject({ patch: null, hidden: 'secret' });
    expect(byPath.get('bin.dat')).toMatchObject({ binary: true, patch: null, hidden: 'binary', status: 'added' });
    expect(r.result.untracked).toEqual(['sub/untracked.txt']);
    expect(JSON.stringify(r.result)).not.toContain('never shown');
    expect(JSON.stringify(r.result)).not.toContain('hunter2');
    expect(r.result.branch).toBe('main');
    expect(r.result.baseSha).toBe(first);
    expect(r.result.totalAdditions).toBeGreaterThanOrEqual(4);
  });

  it('statOnly va sha bazasi', async () => {
    const r = await collectDiff(dir, { statOnly: true, base: first.slice(0, 10) });
    expect(r.ok && r.result.files.every((f) => f.patch === null && f.hidden !== null)).toBe(true);
    expect(r.ok && r.result.baseSha).toBe(first);
  });

  it('noto\'g\'ri baza va git bo\'lmagan papka', async () => {
    const bad = await collectDiff(dir, { base: 'f'.repeat(40) });
    expect(bad).toMatchObject({ ok: false, code: 'base_invalid' });
    const nogit = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-nogit-')));
    try {
      expect(await collectDiff(nogit, {})).toMatchObject({ ok: false, code: 'not_a_git_repo' });
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  });

  it('GIT_EXTERNAL_DIFF va diff.external ishlamaydi', async () => {
    const marker = join(dir, 'ext-ran');
    const script = join(tmpdir(), `cmdr-ext-${process.pid}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const prev = process.env['GIT_EXTERNAL_DIFF'];
    process.env['GIT_EXTERNAL_DIFF'] = script;
    try {
      const r = await collectDiff(dir, {});
      expect(r.ok).toBe(true);
      expect(() => execFileSync('test', ['-e', marker])).toThrow();
    } finally {
      if (prev === undefined) delete process.env['GIT_EXTERNAL_DIFF'];
      else process.env['GIT_EXTERNAL_DIFF'] = prev;
      rmSync(script, { force: true });
    }
  });
});
