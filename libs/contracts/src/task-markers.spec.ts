import { describe, expect, it } from 'vitest';
import { extractTaskMarker, taskKeyFromBranch } from './task-markers.js';

describe('extractTaskMarker', () => {
  it('/task <id> promptning boshida', () => {
    expect(extractTaskMarker('/task 1.4')).toBe('1.4');
    expect(extractTaskMarker('  /task   2.9  keyin matn')).toBe('2.9');
    expect(extractTaskMarker('/task 1.1a')).toBe('1.1a');
    expect(extractTaskMarker('/task 1.1A')).toBe('1.1a');
    expect(extractTaskMarker('/task 12')).toBe('12');
  });

  it('#task:<id> istalgan joyda', () => {
    expect(extractTaskMarker('bu ishni #task:2.9 deb belgila')).toBe('2.9');
    expect(extractTaskMarker('#task:1.4')).toBe('1.4');
    expect(extractTaskMarker('(#task:3.1)')).toBe('3.1');
    expect(extractTaskMarker('oxirida #task:1.4.')).toBe('1.4');
    expect(extractTaskMarker('a\n#task:0.6\nb')).toBe('0.6');
  });

  it('slash form ustun; birinchi inline', () => {
    expect(extractTaskMarker('/task 1.4 #task:2.9')).toBe('1.4');
    expect(extractTaskMarker('#task:1.1 va #task:1.2')).toBe('1.1');
  });

  it('marker emas: bo\'sh, yo\'q, noto\'g\'ri', () => {
    expect(extractTaskMarker(null)).toBeNull();
    expect(extractTaskMarker('')).toBeNull();
    expect(extractTaskMarker('oddiy prompt 1.4 haqida')).toBeNull();
    expect(extractTaskMarker('/task')).toBeNull();
    expect(extractTaskMarker('/task abc')).toBeNull();
    expect(extractTaskMarker('/task 1.4abc')).toBeNull();
    expect(extractTaskMarker('matn /task 1.4')).toBeNull(); // slash faqat boshida
    expect(extractTaskMarker('x#task:1.4')).toBeNull(); // oldidan bo'shliq yo'q
    expect(extractTaskMarker('#task:')).toBeNull();
    expect(extractTaskMarker('/taskx 1.4')).toBeNull();
  });

  it('faqat id qaytaradi: prompt matni hech qachon sizib chiqmaydi', () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRET parol=hunter2';
    const got = extractTaskMarker(`${secret} #task:2.9 ${secret}`);
    expect(got).toBe('2.9');
    expect(got).not.toContain('SECRET');
    expect(got).not.toContain('hunter2');
    expect(extractTaskMarker(`/task 1.4 ${secret}`)).toBe('1.4');
  });

  it('juda uzun promptda ham tez va xatosiz', () => {
    const big = 'a '.repeat(500_000);
    const t0 = Date.now();
    expect(extractTaskMarker(big)).toBeNull();
    expect(extractTaskMarker(`#task:1.4 ${big}`)).toBe('1.4');
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('taskKeyFromBranch', () => {
  it.each([
    ['task/1.4-center-ingest', '1.4'],
    ['task/2.9', '2.9'],
    ['task/7-foo', '7'],
    ['1.4-foo', '1.4'],
    ['feat/2.9-token-per-task', '2.9'],
    ['feature/task-2.9-x', '2.9'],
    ['fix/1.1a-hook', '1.1a'],
    ['Task/1.4-Foo', '1.4'],
  ])('%s -> %s', (branch, key) => {
    expect(taskKeyFromBranch(branch)).toBe(key);
  });

  it.each(['main', 'master', 'develop', 'release/2.9', 'release/1.2-rc', 'hotfix/2.3.1-x', 'v1.2-release', '2024-fix', '12-abc', 'feat/login', 'feat/x-1.4', '', 'HEAD'])('%s -> null', (branch) => {
    expect(taskKeyFromBranch(branch)).toBeNull();
  });

  it('null/undefined', () => {
    expect(taskKeyFromBranch(null)).toBeNull();
    expect(taskKeyFromBranch(undefined)).toBeNull();
  });
});
