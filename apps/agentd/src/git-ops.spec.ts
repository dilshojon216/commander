import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenPrPayload } from '@commander/contracts';
import { GitOps } from './git-ops.js';
import type { GhResult, GhRunner } from './gh.js';
import type { Logger } from './logger.js';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
const res = (p: Partial<GhResult>): GhResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...p });

interface Fake {
  gh: GhRunner;
  calls: string[][];
}
function fakeGh(handler: (args: string[]) => GhResult): Fake {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (_cwd, args) => {
      calls.push([...args]);
      return handler([...args]);
    },
  };
}

describe('GitOps (haqiqiy git, mahalliy origin; gh soxta)', () => {
  let work = '';
  let bare = '';
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: work, encoding: 'utf8' });
  const payload = (over: Partial<OpenPrPayload> = {}): OpenPrPayload => ({ root: work, title: 'Add feature', body: 'Body text\nsecond line', base: 'main', draft: false, ...over });
  const ghOk = (): Fake =>
    fakeGh((a) => {
      if (a[0] === 'auth') return res({});
      if (a[0] === 'pr' && a[1] === 'create') return res({ stdout: 'https://github.com/acme/app/pull/42\n' });
      return res({ code: 1 });
    });

  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-pr-work-')));
    bare = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-pr-bare-')));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(work, 'a.txt'), '1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('remote', 'add', 'origin', bare);
    git('push', '-q', '-u', 'origin', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('checkout', '-q', '-b', 'feat/3.5-x');
    writeFileSync(join(work, 'b.txt'), '2\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feature');
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  it('muvaffaqiyat: push -u origin (force yo\'q), gh pr create argumentlari massiv, natija URL/raqam', async () => {
    const f = ghOk();
    const out = await new GitOps({ log, gh: f.gh }).openPr(payload({ draft: true }));
    expect(out.ok).toBe(true);
    expect(out.result?.pr).toEqual({ url: 'https://github.com/acme/app/pull/42', number: 42, existing: false, branch: 'feat/3.5-x', base: 'main', draft: true, pushed: true });
    const create = f.calls.find((a) => a[0] === 'pr' && a[1] === 'create')!;
    expect(create).toEqual(['pr', 'create', '--title=Add feature', '--body=Body text\nsecond line', '--base=main', '--head=feat/3.5-x', '--draft']);
    // branch haqiqatan origin'ga yuborilgan
    const remote = execFileSync('git', ['rev-parse', 'refs/heads/feat/3.5-x'], { cwd: bare, encoding: 'utf8' }).trim();
    expect(remote).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('sarlavha bayroqqa o\'xshasa ham qiymat bo\'lib qoladi (--title= shakli)', async () => {
    const f = ghOk();
    await new GitOps({ log, gh: f.gh }).openPr(payload({ title: '--web --repo evil/x', body: '--draft' }));
    const create = f.calls.find((a) => a[1] === 'create')!;
    expect(create[2]).toBe('--title=--web --repo evil/x');
    expect(create[3]).toBe('--body=--draft');
    expect(create.filter((a) => a === '--web')).toHaveLength(0);
  });

  it('allaqachon yuborilgan branch qayta push qilinmaydi (pushed=false); mavjud PR qaytariladi', async () => {
    git('push', '-q', '-u', 'origin', 'feat/3.5-x');
    const f = fakeGh((a) => {
      if (a[0] === 'auth') return res({});
      return res({ code: 1, stderr: 'a pull request for branch "feat/3.5-x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/9' });
    });
    const out = await new GitOps({ log, gh: f.gh }).openPr(payload());
    expect(out.result?.pr).toMatchObject({ number: 9, existing: true, pushed: false });
  });

  it('gh yo\'q / avtorizatsiyasiz: hech narsa qilinmaydi', async () => {
    const missing = fakeGh(() => res({ code: null, missing: true }));
    expect(await new GitOps({ log, gh: missing.gh }).openPr(payload())).toMatchObject({ ok: false, code: 'gh_unavailable' });
    const unauth = fakeGh(() => res({ code: 1 }));
    expect(await new GitOps({ log, gh: unauth.gh }).openPr(payload())).toMatchObject({ ok: false, code: 'gh_unauthenticated' });
    expect(unauth.calls).toEqual([['auth', 'status']]);
    expect(execFileSync('git', ['branch', '--list', 'feat/3.5-x'], { cwd: bare, encoding: 'utf8' }).trim()).toBe(''); // push bo'lmagan
  });

  it('default branch\'dan va base==head: rad', async () => {
    git('checkout', '-q', 'main');
    expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload({ base: 'develop' }))).toMatchObject({ ok: false, code: 'on_default_branch' });
    git('checkout', '-q', 'feat/3.5-x');
    expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload({ base: 'feat/3.5-x' }))).toMatchObject({ ok: false, code: 'on_default_branch' });
  });

  it('commit qilinmagan o\'zgarishlar: rad (push ham bo\'lmaydi)', async () => {
    writeFileSync(join(work, 'a.txt'), 'changed\n');
    const f = ghOk();
    expect(await new GitOps({ log, gh: f.gh }).openPr(payload())).toMatchObject({ ok: false, code: 'dirty_worktree' });
    expect(f.calls.some((a) => a[1] === 'create')).toBe(false);
  });

  it('untracked fayl PR\'ni to\'smaydi', async () => {
    writeFileSync(join(work, 'scratch.txt'), 'x');
    expect((await new GitOps({ log, gh: ghOk().gh }).openPr(payload())).ok).toBe(true);
  });

  it('origin yo\'q, commit yo\'q (nothing_to_pr), base topilmadi', async () => {
    expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload({ base: 'nope' }))).toMatchObject({ ok: false, code: 'base_invalid' });
    git('checkout', '-q', '-b', 'empty-branch', 'main');
    expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload())).toMatchObject({ ok: false, code: 'nothing_to_pr' });
    git('checkout', '-q', 'feat/3.5-x');
    git('remote', 'remove', 'origin');
    expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload())).toMatchObject({ ok: false, code: 'no_remote' });
  });

  it('git repo bo\'lmasa', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'cmdr-plain-')));
    try {
      expect(await new GitOps({ log, gh: ghOk().gh }).openPr(payload({ root: plain }))).toMatchObject({ ok: false, code: 'not_a_git_repo' });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('push muvaffaqiyatsiz: push_failed (gh chaqirilmaydi)', async () => {
    git('remote', 'set-url', 'origin', join(bare, 'does-not-exist'));
    const f = ghOk();
    const out = await new GitOps({ log, gh: f.gh }).openPr(payload());
    expect(out).toMatchObject({ ok: false, code: 'push_failed' });
    expect(f.calls.some((a) => a[1] === 'create')).toBe(false);
  });

  describe('ci_status', () => {
    const fixtures = (a: string[]): GhResult => {
      if (a[0] === 'auth') return res({});
      if (a[0] === 'pr' && a[1] === 'list') return res({ stdout: JSON.stringify([{ number: 42, url: 'https://github.com/acme/app/pull/42', state: 'OPEN', title: 'Add feature', isDraft: false }]) });
      if (a[0] === 'pr' && a[1] === 'checks') return res({ code: 1, stdout: JSON.stringify([{ name: 'build', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/5' }, { name: 'lint', bucket: 'pass', link: '' }]) });
      if (a[0] === 'run') return res({ stdout: JSON.stringify([{ databaseId: 5, name: 'CI', status: 'completed', conclusion: 'failure', headSha: 'c'.repeat(40), url: 'https://github.com/acme/app/actions/runs/5' }]) });
      return res({ code: 1 });
    };
    it('PR + tekshiruvlar (chiqish kodi 1 bo\'lsa ham JSON) + run', async () => {
      const f = fakeGh(fixtures);
      const out = await new GitOps({ log, gh: f.gh }).ciStatus({ root: work });
      expect(out.ok).toBe(true);
      expect(out.result?.ci).toMatchObject({ branch: 'feat/3.5-x', state: 'failure', pr: { number: 42, state: 'open' }, run: { id: '5', conclusion: 'failure' } });
      expect(out.result?.ci).toMatchObject({ checks: [{ name: 'build', bucket: 'fail' }, { name: 'lint', bucket: 'pass', link: null }] });
      expect(f.calls.find((a) => a[1] === 'list')).toContain('--head=feat/3.5-x');
      expect(f.calls.some((a) => a.includes('--force') || a[0] === 'pr' && a[1] === 'create')).toBe(false);
    });
    it('gh yo\'q: gh_unavailable; PR yo\'q: run bo\'yicha holat', async () => {
      expect(await new GitOps({ log, gh: fakeGh(() => res({ code: null, missing: true })).gh }).ciStatus({ root: work })).toMatchObject({ ok: false, code: 'gh_unavailable' });
      const noPr = fakeGh((a) => (a[0] === 'pr' ? res({ stdout: '[]' }) : fixtures(a)));
      const out = await new GitOps({ log, gh: noPr.gh }).ciStatus({ root: work, branch: 'feat/3.5-x' });
      expect(out.result?.ci).toMatchObject({ pr: null, checks: [], state: 'failure' });
    });
  });
});
