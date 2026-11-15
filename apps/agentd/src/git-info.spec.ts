import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { authorNameOnly, collectGitInfo, parseGitLog, parseStatusV2, readHead } from './git-info.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test Muallif', '-c', 'user.email=secret@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agd-git-'));
  dirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  return dir;
}

describe('parseStatusV2 / parseGitLog / authorNameOnly (sof)', () => {
  it('status: branch, oid, ahead/behind, dirty (rename 2 token)', () => {
    const out = ['# branch.oid ' + 'a'.repeat(40), '# branch.head feat/x', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 h h a.txt', '2 R. N... 100644 100644 100644 h h R100 new.txt', 'old.txt', '? untracked.txt', ''].join('\0');
    expect(parseStatusV2(out)).toEqual({ branch: 'feat/x', headSha: 'a'.repeat(40), dirtyCount: 3, ahead: 2, behind: 1 });
  });
  it('status: detached va ahead/behind yo\'q', () => {
    expect(parseStatusV2(['# branch.oid ' + 'b'.repeat(40), '# branch.head (detached)', ''].join('\0'))).toMatchObject({ branch: null, ahead: null, dirtyCount: 0 });
  });
  it('log: sarlavha 200 ga, muallifda email yo\'q, sir shakli maskalanadi', () => {
    const sha = 'c'.repeat(40);
    const raw = `${sha}\x1fAli <ali@example.com>\x1f1700000000\x1f${'s'.repeat(300)}\x1e${'d'.repeat(40)}\x1fVali\x1f1700000100\x1ffix: ghp_abcdefghijklmnopqrstuvwxyz0123456789 token: refresh\x1e`;
    const c = parseGitLog(raw);
    expect(c).toHaveLength(2);
    expect(c[0]!.subject).toHaveLength(200);
    expect(c[0]!.author).toBe('Ali');
    expect(c[0]!.ts).toBe(1_700_000_000_000);
    expect(c[1]!.subject).not.toContain('ghp_');
    expect(c[1]!.subject).toContain('token: refresh'); // oddiy so'zlar buzilmaydi
  });
  it('authorNameOnly', () => {
    expect(authorNameOnly('a@b.com')).toBe('unknown');
    expect(authorNameOnly('Ali a@b.uz')).toBe('Ali');
    expect(authorNameOnly('Ali Valiyev')).toBe('Ali Valiyev');
  });
});

describe('readHead (git jarayonisiz)', () => {
  it('branch + sha; commit bo\'lgach sha o\'zgaradi (iz o\'zgaradi)', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'bir');
    const h1 = readHead(dir)!;
    expect(h1.branch).toBe('main');
    expect(h1.sha).toBe(sh(dir, 'rev-parse', 'HEAD').trim());
    writeFileSync(join(dir, 'a.txt'), '2');
    sh(dir, 'commit', '-q', '-am', 'ikki');
    const h2 = readHead(dir)!;
    expect(h2.fingerprint).not.toBe(h1.fingerprint);
    sh(dir, 'pack-refs', '--all');
    expect(readHead(dir)!.sha).toBe(h2.sha); // packed-refs
  });
  it('.git yo\'q -> null; detached', () => {
    const d = mkdtempSync(join(tmpdir(), 'agd-nogit-'));
    dirs.push(d);
    expect(readHead(d)).toBeNull();
    const dir = makeRepo();
    writeFileSync(join(dir, 'a'), '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'x');
    sh(dir, 'checkout', '-q', '--detach');
    expect(readHead(dir)).toMatchObject({ branch: null });
  });
  it('worktree (.git fayl)', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a'), '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'x');
    const wt = join(dir, '..', `${dir.split('/').pop()}-wt`);
    dirs.push(wt);
    sh(dir, 'worktree', 'add', '-q', '-b', 'task/1.4-wt', wt);
    expect(readHead(wt)).toMatchObject({ branch: 'task/1.4-wt', sha: sh(dir, 'rev-parse', 'HEAD').trim() });
  });
});

describe('collectGitInfo (haqiqiy git)', () => {
  it('branch, head, dirty, commitlar (muallif ismi, email yo\'q), remote -> repoKey (login yo\'q)', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.txt'), '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'birinchi commit');
    sh(dir, 'remote', 'add', 'origin', 'https://user:s3cretpass@github.com/Org/Repo.git');
    writeFileSync(join(dir, 'b.txt'), 'x'); // untracked
    const info = await collectGitInfo(dir);
    expect(info.branch).toBe('main');
    expect(info.headSha).toBe(sh(dir, 'rev-parse', 'HEAD').trim());
    expect(info.dirtyCount).toBe(1);
    expect(info.commits).toHaveLength(1);
    expect(info.commits[0]).toMatchObject({ subject: 'birinchi commit', author: 'Test Muallif' });
    expect(JSON.stringify(info)).not.toContain('example.com');
    expect(info.repoKey).toBe('github.com/org/repo');
    expect(JSON.stringify(info)).not.toContain('s3cretpass');
  });
  it('commit\'siz repo va git xatosi: yiqilmaydi, HEAD fayldan', async () => {
    const dir = makeRepo();
    const info = await collectGitInfo(dir);
    expect(info.commits).toEqual([]);
    expect(info.branch).toBe('main');
    const failing = await collectGitInfo(dir, { git: () => Promise.reject(Object.assign(new Error('boom'), { killed: true })) });
    expect(failing.statusTimedOut).toBe(true);
    expect(failing.branch).toBe('main');
  });
  it('simlink va papka: ildiz ichidagi .git bo\'lmasa null', () => {
    const d = mkdtempSync(join(tmpdir(), 'agd-sym-'));
    dirs.push(d);
    mkdirSync(join(d, 'real'));
    symlinkSync(join(d, 'real'), join(d, 'link'));
    expect(readHead(join(d, 'link'))).toBeNull();
  });
});
