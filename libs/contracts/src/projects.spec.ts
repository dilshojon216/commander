import { describe, expect, it } from 'vitest';
import { ProjectSnapshotPayloadSchema, normalizeRepoKey } from './projects.js';

describe('normalizeRepoKey: login/token HECH QACHON kirmaydi', () => {
  it.each([
    ['https://github.com/org/repo.git', 'github.com/org/repo'],
    ['https://github.com/org/repo', 'github.com/org/repo'],
    ['https://github.com/Org/Repo.git/', 'github.com/org/repo'],
    ['git@github.com:org/repo.git', 'github.com/org/repo'],
    ['ssh://git@github.com/org/repo.git', 'github.com/org/repo'],
    ['ssh://git@git.example.uz:2222/team/proj.git', 'git.example.uz/team/proj'],
    ['https://user:s3cretpass@github.com/org/repo.git', 'github.com/org/repo'],
    ['https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/org/repo.git', 'github.com/org/repo'],
    ['https://oauth2:glpat-abcdefghijklmnop@gitlab.com/g/s/p.git', 'gitlab.com/g/s/p'],
    ['https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo', 'github.com/org/repo'],
    ['https://github.com/org/repo.git?token=abc123#frag', 'github.com/org/repo'],
    ['https://gitlab.example.com:8443/a/b.git', 'gitlab.example.com/a/b'],
    ['  git@bitbucket.org:team/repo.git  ', 'bitbucket.org/team/repo'],
  ])('%s', (url, key) => {
    expect(normalizeRepoKey(url)).toBe(key);
  });

  it('natijada sir bo\'lmaydi', () => {
    for (const url of [
      'https://user:s3cretpass@github.com/org/repo.git',
      'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/org/repo.git',
      'https://github.com/org/repo.git?access_token=zzz',
    ]) {
      const k = normalizeRepoKey(url) ?? '';
      expect(k).not.toMatch(/s3cretpass|ghp_|zzz|@|:/);
    }
  });

  it.each([null, undefined, '', '/srv/git/repo.git', 'file:///srv/git/repo.git', '../repo', 'C:\\repos\\x', 'repo', 'a b', 'https://localhost/x', 'https://github.com'])('%s -> null', (url) => {
    expect(normalizeRepoKey(url as string | null | undefined)).toBeNull();
  });
});

describe('ProjectSnapshotPayloadSchema', () => {
  const base = { path: '/p', name: 'p', kind: 'git' as const, commits: [], hash: 'a'.repeat(64), takenAt: 1_700_000_000_000 };
  it('minimal yaroqli', () => {
    expect(ProjectSnapshotPayloadSchema.safeParse(base).success).toBe(true);
  });
  it('yaroqsiz: hash, sha, repoKey, uzun md', () => {
    expect(ProjectSnapshotPayloadSchema.safeParse({ ...base, hash: 'zz' }).success).toBe(false);
    expect(ProjectSnapshotPayloadSchema.safeParse({ ...base, headSha: 'nothex' }).success).toBe(false);
    expect(ProjectSnapshotPayloadSchema.safeParse({ ...base, repoKey: 'https://user:pw@github.com/x/y' }).success).toBe(false);
    expect(ProjectSnapshotPayloadSchema.safeParse({ ...base, tasksMd: 'x'.repeat(90_000) }).success).toBe(false);
    expect(ProjectSnapshotPayloadSchema.safeParse({ ...base, tasksPath: '../../etc/passwd' }).success).toBe(false);
  });
});
