import { describe, expect, it } from 'vitest';
import { DEFAULT_SUMMARY_SETTINGS } from '@commander/contracts';
import type { CheckInput } from './summary-logic.js';
import { buildSearchText, buildTsQuery, evaluateCheck, likePattern, normTitle, normalizeSettings, tashkentDay } from './summary-logic.js';

const M = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';

describe('buildTsQuery / likePattern', () => {
  it('makes prefix AND queries from letters and digits only (no tsquery syntax injection)', () => {
    expect(buildTsQuery('Login xato')).toBe('login:* & xato:*');
    expect(buildTsQuery("o'zbek (a | b) & !c <-> d:*")).toBe('o:* & zbek:* & a:* & b:* & c:* & d:*');
    expect(buildTsQuery('  ***  ')).toBeNull();
    expect(buildTsQuery('a b c d e f g h i j')!.split(' & ')).toHaveLength(8);
  });
  it('escapes LIKE metacharacters', () => {
    expect(likePattern('50%_off\\x')).toBe('%50\\%\\_off\\\\x%');
  });
});

describe('buildSearchText / tashkentDay', () => {
  it('joins summary, done, open items and files', () => {
    expect(buildSearchText({ summary: 'S', done: ['d1'], openItems: ['o1'], files: ['f.ts'] })).toBe('S\nd1\no1\nf.ts');
  });
  it('uses the Asia/Tashkent calendar day (UTC+5)', () => {
    expect(tashkentDay(new Date('2026-11-14T19:30:00Z'))).toBe('2026-11-15');
    expect(tashkentDay(new Date('2026-11-14T18:59:00Z'))).toBe('2026-11-14');
  });
});

describe('evaluateCheck', () => {
  const ok = { settings: DEFAULT_SUMMARY_SETTINGS, known: true, machineId: M, projectId: P, usedToday: 0 };
  it('allows by default and carries thresholds', () => {
    expect(evaluateCheck(ok)).toEqual({ allow: true, minPrompts: 2, minTokens: 20_000 });
  });
  it.each([
    ['unknown_session', { ...ok, known: false }],
    ['disabled', { ...ok, settings: { ...DEFAULT_SUMMARY_SETTINGS, enabled: false } }],
    ['machine_disabled', { ...ok, settings: { ...DEFAULT_SUMMARY_SETTINGS, disabledMachineIds: [M] } }],
    ['project_disabled', { ...ok, settings: { ...DEFAULT_SUMMARY_SETTINGS, disabledProjectIds: [P] } }],
    ['daily_cap', { ...ok, usedToday: DEFAULT_SUMMARY_SETTINGS.dailyCap }],
  ] as Array<[string, CheckInput]>)('refuses with %s', (reason, input) => {
    expect(evaluateCheck(input)).toMatchObject({ allow: false, reason });
  });
  it('a session without a project is only subject to global/machine rules', () => {
    expect(evaluateCheck({ ...ok, projectId: null, settings: { ...DEFAULT_SUMMARY_SETTINGS, disabledProjectIds: [P] } }).allow).toBe(true);
  });
});

describe('normalizeSettings / normTitle', () => {
  it('falls back to defaults for junk and merges partial values', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SUMMARY_SETTINGS);
    expect(normalizeSettings({ dailyCap: -5 })).toEqual(DEFAULT_SUMMARY_SETTINGS);
    expect(normalizeSettings({ dailyCap: 5 }).dailyCap).toBe(5);
  });
  it('normalizes titles for dedup', () => {
    expect(normTitle('  Redis -- kesh!  ')).toBe(normTitle('redis kesh'));
  });
});
