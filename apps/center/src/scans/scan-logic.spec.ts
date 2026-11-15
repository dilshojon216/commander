import { describe, expect, it } from 'vitest';
import type { ProjectScanSummary, ScanFinding } from '@commander/contracts';
import { formatFindingLine, formatScanDigest } from './scan-format.js';
import { DIGEST_GRACE_MS, EMPTY_SCHEDULE, decideSchedule, digestAttention, digestTopFindings, digestTotals, lastDue, latestPerKey, nextDue, parseSchedule } from './scan-logic.js';
import type { DigestRow } from './scan-logic.js';

describe('haftalik reja: yakshanba 06:00 Toshkent', () => {
  it('yakshanba 05:59 oldingi haftaniki, 06:00 yangisi', () => {
    // 2026-11-15 = yakshanba
    expect(lastDue(new Date('2026-11-15T00:59:59Z')).key).toBe('2026-11-08'); // 05:59:59 Toshkent
    expect(lastDue(new Date('2026-11-15T01:00:00Z')).key).toBe('2026-11-15'); // 06:00:00 Toshkent
    expect(lastDue(new Date('2026-11-15T01:00:00Z')).at.toISOString()).toBe('2026-11-15T01:00:00.000Z');
  });
  it('hafta o\'rtasida oxirgi yakshanba; shanba kechqurun (UTC yakshanbaga o\'tgan) hali oldingi', () => {
    expect(lastDue(new Date('2026-11-18T10:00:00Z')).key).toBe('2026-11-15');
    // shanba 23:30 Toshkent = 18:30 UTC shanba
    expect(lastDue(new Date('2026-11-14T18:30:00Z')).key).toBe('2026-11-08');
    // yakshanba 00:30 Toshkent = shanba 19:30 UTC: Toshkent bo'yicha allaqachon yakshanba, lekin 06:00 emas
    expect(lastDue(new Date('2026-11-14T19:30:00Z')).key).toBe('2026-11-08');
  });
  it('nextDue qat\'iy keyingi yakshanba 06:00', () => {
    expect(nextDue(new Date('2026-11-15T01:00:00Z')).toISOString()).toBe('2026-11-22T01:00:00.000Z');
    expect(nextDue(new Date('2026-11-14T10:00:00Z')).toISOString()).toBe('2026-11-15T01:00:00.000Z');
  });
  it('decideSchedule: birinchi tik init (skan yo\'q); o\'tgan yakshanba -> run; o\'chiq -> idle; running -> idle', () => {
    const now = new Date('2026-11-15T02:00:00Z');
    expect(decideSchedule({ now, enabled: true, digest: true, state: EMPTY_SCHEDULE, running: false })).toEqual({ kind: 'init', dueKey: '2026-11-15' });
    expect(decideSchedule({ now, enabled: true, digest: true, state: { ...EMPTY_SCHEDULE, dueKey: '2026-11-08' }, running: false })).toEqual({ kind: 'run', dueKey: '2026-11-15' });
    expect(decideSchedule({ now, enabled: true, digest: true, state: { ...EMPTY_SCHEDULE, dueKey: '2026-11-15' }, running: false })).toEqual({ kind: 'idle' });
    expect(decideSchedule({ now, enabled: false, digest: true, state: { ...EMPTY_SCHEDULE, dueKey: '2026-11-08' }, running: false })).toEqual({ kind: 'idle' });
    expect(decideSchedule({ now, enabled: true, digest: true, state: { ...EMPTY_SCHEDULE, dueKey: '2026-11-08' }, running: true })).toEqual({ kind: 'idle' });
  });
  it('dayjest: markaz qayta ishga tushsa DIGEST_GRACE_MS dan keyin yuboriladi', () => {
    const started = new Date('2026-11-15T01:00:00Z');
    const state = { dueKey: '2026-11-15', runStartedAt: started.toISOString(), digestPending: true };
    expect(decideSchedule({ now: new Date(started.getTime() + 60_000), enabled: true, digest: true, state, running: false })).toEqual({ kind: 'idle' });
    expect(decideSchedule({ now: new Date(started.getTime() + DIGEST_GRACE_MS), enabled: true, digest: true, state, running: false })).toEqual({ kind: 'digest' });
  });
  it('parseSchedule: yaroqsiz qiymatlar bo\'sh holatga', () => {
    expect(parseSchedule(null)).toEqual(EMPTY_SCHEDULE);
    expect(parseSchedule({ dueKey: 'x', runStartedAt: 5, digestPending: 'y' })).toEqual(EMPTY_SCHEDULE);
    expect(parseSchedule({ dueKey: '2026-11-15', runStartedAt: 'z', digestPending: true })).toEqual({ dueKey: '2026-11-15', runStartedAt: 'z', digestPending: true });
  });
});

const f = (over: Partial<ScanFinding>): ScanFinding => ({ kind: 'vulnerability', tool: 'npm-audit', severity: 'high', package: 'p', version: '1', fixVersion: '2', advisoryIds: ['GHSA-1'], title: 't', file: null, line: null, rule: null, direct: null, ...over });
const row = (over: Partial<DigestRow> = {}): DigestRow => ({ projectName: 'app', machineName: 'mac', counts: { critical: 0, high: 0, moderate: 2, low: 1, info: 0 }, secretCount: 0, vulnCount: 3, outdatedCount: 4, partial: false, top: [], ...over });

describe('dayjest', () => {
  it('faqat critical/high/sir bor loyihalar batafsil, jiddiyligi bo\'yicha; sonlar to\'g\'ri', () => {
    const rows = [row({ projectName: 'quiet' }), row({ projectName: 'hi', counts: { critical: 0, high: 2, moderate: 0, low: 0, info: 0 } }), row({ projectName: 'crit', counts: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 } }), row({ projectName: 'sec', secretCount: 2 })];
    expect(digestAttention(rows).map((r) => r.projectName)).toEqual(['crit', 'hi', 'sec']);
    expect(digestTotals(rows)).toEqual({ projects: 4, critical: 1, high: 2, secrets: 2, outdated: 16, partial: 0 });
  });
  it('digestTopFindings: moderate va outdated tashlanadi', () => {
    const top = digestTopFindings([f({ severity: 'moderate' }), f({ severity: 'high', package: 'h' }), f({ kind: 'outdated', severity: 'info' }), f({ severity: 'critical', package: 'c' })]);
    expect(top.map((x) => x.package)).toEqual(['c', 'h']);
  });
  it('matn: sir uchun faqat fayl:qator+qoida; HTML escape; bo\'sh va "toza" holatlar; ogohlantirishlar', () => {
    const secret = f({ kind: 'secret', tool: 'secret-scan', severity: 'high', package: null, version: null, fixVersion: null, advisoryIds: [], file: 'src/<a>.ts', line: 7, rule: 'github-token', title: 'GitHub token' });
    expect(formatFindingLine(secret)).toBe('🟠 sir: <code>src/&lt;a&gt;.ts:7</code> (github-token)');
    expect(formatFindingLine(f({ severity: 'critical', package: 'lodash', version: '4.17.10', fixVersion: '4.17.21', advisoryIds: ['GHSA-a', 'CVE-b', 'X'] }))).toBe('🔴 <code>lodash@4.17.10</code> → 4.17.21 GHSA-a, CVE-b');
    expect(formatFindingLine(f({ package: 'z', fixVersion: null, advisoryIds: [] }))).toContain("tuzatish yo'q");
    expect(formatScanDigest([], { date: '2026-11-15', failed: 0 })[0]).toContain('topilmadi');
    const clean = formatScanDigest([row()], { date: '2026-11-15', failed: 1 }).join('\n');
    expect(clean).toContain("Critical/high topilma va commit qilingan sir yo'q");
    expect(clean).toContain('1 loyiha tekshirilmadi');
    const bad = formatScanDigest([row({ projectName: 'a<b', counts: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 }, top: [f({ severity: 'critical', package: 'lodash' }), secret], secretCount: 1, partial: true })], { date: '2026-11-15', failed: 0 }).join('\n');
    expect(bad).toContain('a&lt;b');
    expect(bad).toContain('lodash');
    expect(bad).toContain('ba\'zi asboblar ishlamadi');
  });
  it('uzun dayjest 4096 dan oshmaydigan bo\'laklarga bo\'linadi', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ projectName: `project-${i}`, counts: { critical: 1, high: 1, moderate: 0, low: 0, info: 0 }, top: Array.from({ length: 3 }, (_, j) => f({ package: `pkg-${i}-${j}-${'x'.repeat(40)}`, severity: 'critical' })) }));
    const parts = formatScanDigest(rows, { date: '2026-11-15', failed: 0 });
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
  });
  it('latestPerKey: bir repo bir nechta mashinada bo\'lsa eng yangisi', () => {
    const mk = (key: string, at: string): ProjectScanSummary => ({ scanId: crypto.randomUUID(), projectId: crypto.randomUUID(), projectKey: key, projectName: key, machineId: crypto.randomUUID(), machineName: 'm', scannedAt: at, counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }, vulnCount: 0, outdatedCount: 0, secretCount: 0, envFileCount: 0, ecosystems: [], partial: false, trend: [] });
    const out = latestPerKey([mk('a', '2026-11-01'), mk('a', '2026-11-08'), mk('b', '2026-11-02')]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.projectKey === 'a')?.scannedAt).toBe('2026-11-08');
  });
});
