import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointListResult, CheckpointResult, CheckpointRestoreResult } from '@commander/contracts';
import { GitCheckpoints, parseCheckpointCommit } from './git-checkpoints.js';
import type { Logger } from './logger.js';
import { resetTrustedBins } from './trusted-bin.js';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

describe('GitCheckpoints (haqiqiy vaqtinchalik git repo)', () => {
  let work = '';
  let n = 0;
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' });
  const write = (rel: string, text: string): void => {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    writeFileSync(join(work, rel), text);
  };
  const read = (rel: string): string => readFileSync(join(work, rel), 'utf8');
  const mk = (): GitCheckpoints => new GitCheckpoints({ log, now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, n++)) });
  const create = async (c: GitCheckpoints, label = 'big task'): Promise<CheckpointResult> => {
    const r = await c.create({ root: work, label });
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return (r.result as { checkpoint: CheckpointResult }).checkpoint;
  };

  beforeEach(() => {
    resetTrustedBins();
    work = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-ckpt-')));
    git('init', '-q', '-b', 'main');
    write('a.txt', 'a1\n');
    write('b.txt', 'b1\n');
    write('dir/c.txt', 'c1\n');
    write('.gitignore', 'ignored.log\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it('create: ishchi daraxt, indeks, HEAD va refs o\'zgarmaydi; ref nomi va marker', async () => {
    write('a.txt', 'a2\n'); // unstaged
    write('b.txt', 'b2\n');
    git('add', 'b.txt'); // staged
    write('new.txt', 'untracked\n');
    const before = { status: git('status', '--porcelain=v1'), head: git('rev-parse', 'HEAD'), index: git('write-tree'), branches: git('branch', '--list') };
    const ck = await create(mk());
    expect(ck.checkpoint.ref).toMatch(/^refs\/commander\/checkpoints\/20261114T1000\d\dZ-big-task$/);
    expect(ck.checkpoint.headSha).toBe(before.head.trim());
    expect(ck.checkpoint.untracked).toBe(1);
    expect(ck.clean).toBe(false);
    const after = { status: git('status', '--porcelain=v1'), head: git('rev-parse', 'HEAD'), index: git('write-tree'), branches: git('branch', '--list') };
    expect(after).toEqual(before); // ishchi daraxt/indeks/HEAD/branch'larga tegilmadi
    expect(read('a.txt')).toBe('a2\n');
    // stash formati: tree = ishchi daraxt (kuzatilmayotgan ham), 2 ota-ona
    const files = git('ls-tree', '-r', '--name-only', ck.checkpoint.sha).split('\n');
    expect(files).toContain('new.txt');
    expect(git('show', `${ck.checkpoint.sha}:a.txt`)).toBe('a2\n');
    expect(git('show', `${ck.checkpoint.sha}:b.txt`)).toBe('b2\n');
    expect(git('rev-list', '--parents', '-n1', ck.checkpoint.sha).trim().split(' ')).toHaveLength(3);
  });

  it('create: toza daraxt -> clean=true; maxfiy va ignor qilingan fayllar olinmaydi', async () => {
    const c0 = await create(mk(), 'clean one');
    expect(c0.clean).toBe(true);
    write('.env', 'API_TOKEN=supersecret\n');
    write('ignored.log', 'x\n');
    write('server.pem', 'PEM\n');
    write('ok.txt', 'ok\n');
    const ck = await create(mk(), 'with secrets');
    const files = git('ls-tree', '-r', '--name-only', ck.checkpoint.sha).split('\n');
    expect(files).toContain('ok.txt');
    expect(files).not.toContain('.env');
    expect(files).not.toContain('server.pem');
    expect(files).not.toContain('ignored.log');
    expect(ck.untrackedSkipped).toBe(2);
    expect(git('cat-file', '-p', ck.checkpoint.sha)).not.toContain('supersecret');
  });

  it('create: bir soniyada bir xil yorliq to-qnashuvi -2 qo-shimcha (ref tozalanadi)', async () => {
    const c = new GitCheckpoints({ log, now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, 0)) });
    const a = await create(c, 'My Task');
    const b = await create(c, 'My Task');
    expect(a.checkpoint.ref).toMatch(/-my-task$/);
    expect(b.checkpoint.ref).toMatch(/-my-task-2$/);
  });

  it('create: commit yo\'q repo -> no_commits; git repo emas -> checkpoint_failed', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-empty-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: empty });
      const r = await mk().create({ root: empty, label: 'x' });
      expect(r).toMatchObject({ ok: false, code: 'no_commits' });
      const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-norepo-')));
      try {
        expect(await mk().create({ root: notRepo, label: 'x' })).toMatchObject({ ok: false });
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('list: eng yangisi birinchi; faqat Commander checkpoint\'lari; begona ref e\'tiborsiz', async () => {
    const c = mk();
    await create(c, 'one');
    await create(c, 'two');
    git('update-ref', 'refs/commander/checkpoints/20261114T100000Z-fake', git('rev-parse', 'HEAD').trim()); // markersiz commit
    const r = await c.list({ root: work });
    const list = (r as { result: { checkpoint: CheckpointListResult } }).result.checkpoint;
    expect(list.items.map((i) => i.label)).toEqual(['two', 'one']);
    expect(list.total).toBe(3); // fake ref sanaladi, lekin ro'yxatga kirmaydi
    expect(list.items[0]!.branch).toBe('main');
  });

  it('restore: tracked (staged/unstaged), o\'chirilgan va kuzatilmayotgan fayllar; pre-restore avtomatik; keyin yaratilgan untracked qoladi', async () => {
    write('a.txt', 'a2\n'); // unstaged
    write('b.txt', 'b2\n');
    git('add', 'b.txt'); // staged
    git('rm', '-q', '-f', 'dir/c.txt'); // staged delete
    write('new.txt', 'untracked1\n');
    const c = mk();
    const ck = await create(c);
    // keyin: hamma narsani buzamiz
    write('a.txt', 'CHANGED\n');
    git('checkout', '--', 'b.txt');
    write('b.txt', 'b-broken\n');
    write('dir/c.txt', 'c-back\n');
    write('new.txt', 'untracked-modified\n');
    write('later.txt', 'created later\n');
    const r = await c.restore({ root: work, ref: ck.checkpoint.ref as never });
    expect(r).toMatchObject({ ok: true });
    const out = (r as { result: { checkpoint: CheckpointRestoreResult } }).result.checkpoint;
    expect(out.headMoved).toBe(false);
    expect(out.preRestore.auto).toBe(true);
    expect(out.preRestore.label).toBe('pre-restore');
    expect(read('a.txt')).toBe('a2\n');
    expect(read('b.txt')).toBe('b2\n');
    expect(existsSync(join(work, 'dir/c.txt'))).toBe(false);
    expect(read('new.txt')).toBe('untracked1\n');
    expect(read('later.txt')).toBe('created later\n'); // checkpoint'dan keyin yaratilgan: tegilmaydi
    // staged/unstaged farqi tiklandi: b.txt staged (M ), a.txt unstaged ( M), c.txt staged delete (D ), new.txt untracked
    const st = git('status', '--porcelain=v1').split('\n').filter(Boolean).sort();
    expect(st).toEqual(['?? later.txt', '?? new.txt', ' M a.txt', 'D  dir/c.txt', 'M  b.txt'].sort());
    // pre-restore'dan qaytish: oldingi (buzilgan) holat
    const back = await c.restore({ root: work, ref: out.preRestore.ref as never });
    expect(back).toMatchObject({ ok: true });
    expect(read('a.txt')).toBe('CHANGED\n');
    expect(read('b.txt')).toBe('b-broken\n');
  });

  it('restore: HEAD oldinga ketgan bo\'lsa branch orqaga suriladi (headMoved), commitlar pre-restore orqali saqlanadi', async () => {
    write('a.txt', 'wip\n');
    const c = mk();
    const ck = await create(c);
    const startHead = git('rev-parse', 'HEAD').trim();
    git('commit', '-q', '-am', 'agent work 1');
    write('x.txt', 'x\n');
    git('add', 'x.txt');
    git('commit', '-q', '-m', 'agent work 2');
    const agentHead = git('rev-parse', 'HEAD').trim();
    const r = await c.restore({ root: work, ref: ck.checkpoint.ref as never });
    expect(r).toMatchObject({ ok: true });
    const out = (r as { result: { checkpoint: CheckpointRestoreResult } }).result.checkpoint;
    expect(out.headMoved).toBe(true);
    expect(git('rev-parse', 'HEAD').trim()).toBe(startHead);
    expect(git('branch', '--show-current').trim()).toBe('main');
    expect(existsSync(join(work, 'x.txt'))).toBe(false);
    expect(read('a.txt')).toBe('wip\n');
    // agent commitlari yo'qolmadi: pre-restore commit'i ularni ota-ona sifatida saqlaydi
    expect(git('merge-base', '--is-ancestor', agentHead, out.preRestore.sha) === '').toBe(true);
    expect(git('branch', '--list')).toContain('main');
  });

  it('restore: noto\'g\'ri ref, markersiz ref, branch o\'zgargan, HEAD ajralgan -> rad (hech narsa o\'zgarmaydi)', async () => {
    const c = mk();
    const ck = await create(c);
    expect(await c.restore({ root: work, ref: 'refs/heads/main' as never })).toMatchObject({ ok: false, code: 'checkpoint_not_found' });
    git('update-ref', 'refs/commander/checkpoints/20261114T100000Z-fake', git('rev-parse', 'HEAD').trim());
    expect(await c.restore({ root: work, ref: 'refs/commander/checkpoints/20261114T100000Z-fake' as never })).toMatchObject({ ok: false, code: 'checkpoint_not_found' });
    git('checkout', '-q', '-b', 'feature');
    expect(await c.restore({ root: work, ref: ck.checkpoint.ref as never })).toMatchObject({ ok: false, code: 'branch_changed' });
    git('checkout', '-q', 'main');
    // main'ni boshqa tarixga o'tkazamiz (ajdod emas)
    git('checkout', '-q', '--orphan', 'tmp');
    git('commit', '-q', '--allow-empty', '-m', 'other root');
    git('branch', '-q', '-M', 'main2');
    git('checkout', '-q', '-B', 'main');
    expect(await c.restore({ root: work, ref: ck.checkpoint.ref as never })).toMatchObject({ ok: false, code: 'head_diverged' });
  });

  it('parseCheckpointCommit: marker/maydon yaroqsiz bo\'lsa null', () => {
    expect(parseCheckpointCommit('refs/commander/checkpoints/20261114T100000Z-x', 'a'.repeat(40), 'tree x\n\nmsg')).toBeNull();
  });
});
