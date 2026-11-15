import { describe, expect, it } from 'vitest';
import type { CommandDto, DiffResult } from '@commander/contracts';
import { formatCiFailure, formatDiffStat, formatPrCard, formatPrProgress, gitErrorTextUz } from './telegram-git.js';

const diff = (over: Partial<DiffResult> = {}): DiffResult => ({
  base: 'HEAD',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  branch: 'feat/<x>',
  files: [
    { path: 'src/<a>.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false, patch: 'SECRET PATCH BODY', truncated: false, hidden: null },
    { path: 'img.png', oldPath: null, status: 'added', additions: null, deletions: null, binary: true, patch: null, truncated: false, hidden: 'binary' },
  ],
  filesTotal: 2,
  totalAdditions: 3,
  totalDeletions: 1,
  untracked: ['n.txt'],
  untrackedTotal: 1,
  bytes: 10,
  truncated: false,
  ...over,
});

describe('formatDiffStat', () => {
  it('statistika: fayl nomlari va +/-, HTML escape; patch matni YO\'Q', () => {
    const t = formatDiffStat(diff(), { projectName: 'p<1>', baseSource: 'session_start' });
    expect(t).toContain('2 fayl');
    expect(t).toContain('+3');
    expect(t).toContain('src/&lt;a&gt;.ts');
    expect(t).toContain('binar');
    expect(t).toContain('Kuzatilmayotgan: 1');
    expect(t).toContain('sessiya boshidan');
    expect(t).not.toContain('SECRET PATCH BODY');
    expect(t).not.toMatch(/<a>|<1>/);
  });
  it('bo\'sh diff va uzun ro\'yxat kesiladi', () => {
    expect(formatDiffStat(diff({ files: [], filesTotal: 0, totalAdditions: 0, totalDeletions: 0 }), { projectName: 'p', baseSource: 'head' })).toContain('O\'zgarish yo\'q');
    const many = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, oldPath: null, status: 'modified' as const, additions: 1, deletions: 0, binary: false, patch: null, truncated: false, hidden: 'stat_only' as const }));
    const t = formatDiffStat(diff({ files: many, filesTotal: 30 }), { projectName: 'p', baseSource: 'snapshot' });
    expect(t).toContain('yana 18 fayl');
    expect(t.length).toBeLessThan(4096);
  });
});

describe('PR kartasi va natijasi', () => {
  it('karta: sarlavha redakt qilinadi, tana ko\'rsatilmaydi', () => {
    const t = formatPrCard({ projectName: 'proj', title: 'Fix token=sk-ant-abcdefghijklmnop <b>', head: 'feat/x', base: 'main' });
    expect(t).not.toContain('sk-ant-abcdefghijklmnop');
    expect(t).toContain('&lt;b&gt;');
    expect(t).toContain('feat/x');
  });
  const dto = (over: Partial<CommandDto>): CommandDto => ({ status: 'done', errorCode: null, result: null, ...over }) as CommandDto;
  it('progress: muvaffaqiyat URL, xato o\'zbekcha, https bo\'lmasa URL ko\'rsatilmaydi', () => {
    expect(formatPrProgress(dto({ result: { pr: { url: 'https://github.com/a/b/pull/7', number: 7, existing: false } } }))).toContain('#7');
    expect(formatPrProgress(dto({ result: { pr: { url: 'javascript:x', number: 7 } } }))).not.toContain('javascript');
    expect(formatPrProgress(dto({ status: 'failed', errorCode: 'gh_unavailable' }))).toContain('GitHub CLI');
    expect(formatPrProgress(dto({ status: 'sent' }))).toContain('yuborildi');
    expect(gitErrorTextUz('zzz')).toBe('Bajarilmadi');
  });
});

describe('formatCiFailure', () => {
  it('faqat nomlar va havola', () => {
    const t = formatCiFailure({ projectId: 'x', branch: 'feat/x', prNumber: 42, prUrl: 'https://github.com/a/b/pull/42', runName: 'CI', runUrl: null, failing: ['build', 'test<1>'] }, 'proj');
    expect(t).toContain('PR #42');
    expect(t).toContain('build, test&lt;1&gt;');
    expect(t).toContain('https://github.com/a/b/pull/42');
  });
});
