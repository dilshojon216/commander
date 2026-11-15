import { describe, expect, it } from 'vitest';
import { cleanText, deriveCiState, detectGh, isPrExistsError, parseGhChecks, parseGhPrList, parseGhRuns, parsePrUrl, safeLink } from './gh.js';
import type { GhResult, GhRunner } from './gh.js';

const res = (p: Partial<GhResult>): GhResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...p });

describe('gh mavjudligi', () => {
  it('ok | missing | unauthenticated (interaktivsiz `gh auth status`)', async () => {
    const calls: string[][] = [];
    const mk = (r: GhResult): GhRunner => async (_c, args) => {
      calls.push([...args]);
      return r;
    };
    expect(await detectGh(mk(res({})), '/r')).toBe('ok');
    expect(await detectGh(mk(res({ code: null, missing: true })), '/r')).toBe('missing');
    expect(await detectGh(mk(res({ code: 1, stderr: 'You are not logged into any GitHub hosts' })), '/r')).toBe('unauthenticated');
    expect(calls.every((a) => a.join(' ') === 'auth status')).toBe(true);
  });
});

describe('PR URL', () => {
  it('stdout va "allaqachon bor" xatosi', () => {
    expect(parsePrUrl('Creating pull request...\nhttps://github.com/acme/app/pull/42\n')).toEqual({ url: 'https://github.com/acme/app/pull/42', number: 42 });
    expect(parsePrUrl('nothing here')).toBeNull();
    expect(parsePrUrl('http://github.com/a/b/pull/1')).toBeNull();
    const err = 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/7';
    expect(isPrExistsError(err)).toBe(true);
    expect(parsePrUrl(err)?.number).toBe(7);
    expect(isPrExistsError('boom')).toBe(false);
  });
});

describe('gh JSON fixtures', () => {
  const prList = JSON.stringify([{ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'OPEN', title: 'Fix\nbug', isDraft: true }]);
  it('gh pr list', () => {
    expect(parseGhPrList(prList)).toEqual({ number: 12, url: 'https://github.com/acme/app/pull/12', state: 'open', title: 'Fix bug', draft: true });
    expect(parseGhPrList('[]')).toBeNull();
    expect(parseGhPrList('not json')).toBeNull();
    expect(parseGhPrList(JSON.stringify([{ number: 1, url: 'javascript:alert(1)', state: 'OPEN', title: 'x' }]))).toBeNull();
    expect(parseGhPrList(JSON.stringify([{ number: 3, url: 'https://github.com/a/b/pull/3', state: 'MERGED', title: 't' }]))?.state).toBe('merged');
  });
  const checks = JSON.stringify([
    { name: 'build', bucket: 'pass', link: 'https://github.com/acme/app/actions/runs/1/job/2' },
    { name: 'test', bucket: 'fail', link: 'javascript:alert(1)' },
    { name: 'lint', bucket: 'pending', link: '' },
    { name: 'x', bucket: 'weird' },
    { bucket: 'pass' },
    'junk',
  ]);
  it('gh pr checks: noma\'lum bucket tashlanadi, havola faqat https', () => {
    expect(parseGhChecks(checks)).toEqual([
      { name: 'build', bucket: 'pass', link: 'https://github.com/acme/app/actions/runs/1/job/2' },
      { name: 'test', bucket: 'fail', link: null },
      { name: 'lint', bucket: 'pending', link: null },
    ]);
    expect(parseGhChecks('no checks reported')).toEqual([]);
    expect(parseGhChecks('{"a":1}')).toEqual([]);
  });
  const runs = JSON.stringify([
    { databaseId: 98765, name: 'CI', status: 'completed', conclusion: 'failure', headSha: 'a'.repeat(40), url: 'https://github.com/acme/app/actions/runs/98765' },
    { databaseId: 98764, name: 'CI', status: 'completed', conclusion: 'success', headSha: 'b'.repeat(40), url: 'https://github.com/acme/app/actions/runs/98764' },
  ]);
  it('gh run list: eng yangisi', () => {
    expect(parseGhRuns(runs)).toEqual({ id: '98765', name: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/app/actions/runs/98765', headSha: 'a'.repeat(40) });
    expect(parseGhRuns('[]')).toBeNull();
    expect(parseGhRuns(JSON.stringify([{ name: 'x' }]))).toBeNull();
    expect(parseGhRuns(JSON.stringify([{ databaseId: 5, status: 'in_progress', conclusion: '' }]))).toMatchObject({ id: '5', status: 'in_progress', conclusion: null });
  });
  it('umumiy CI holati', () => {
    const c = (...b: Array<'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'>) => b.map((bucket, i) => ({ name: `c${i}`, bucket, link: null }));
    expect(deriveCiState(c('pass', 'fail', 'pending'), null)).toBe('failure');
    expect(deriveCiState(c('pass', 'pending'), null)).toBe('pending');
    expect(deriveCiState(c('pass', 'skipping'), null)).toBe('success');
    expect(deriveCiState(c('skipping'), null)).toBe('unknown');
    expect(deriveCiState(c('cancel'), null)).toBe('unknown');
    expect(deriveCiState([], null)).toBe('none');
    const run = (status: string, conclusion: string | null) => ({ id: '1', name: 'CI', status, conclusion, url: null, headSha: null });
    expect(deriveCiState([], run('in_progress', null))).toBe('pending');
    expect(deriveCiState([], run('completed', 'success'))).toBe('success');
    expect(deriveCiState([], run('completed', 'timed_out'))).toBe('failure');
    expect(deriveCiState([], run('completed', 'cancelled'))).toBe('unknown');
  });
  it('yordamchilar', () => {
    expect(cleanText('a\u0000b\nc', 10)).toBe('a b c');
    expect(cleanText(5, 10)).toBe('');
    expect(safeLink('https://x.y/z')).toBe('https://x.y/z');
    expect(safeLink('http://x.y')).toBeNull();
    expect(safeLink('https://x.y/ a')).toBeNull();
  });
});
