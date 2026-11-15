import { describe, expect, it } from 'vitest';
import { BUDGET_LIMITS, BUDGET_TOKEN_WEIGHTS, budgetExceededMessage } from '@commander/contracts';
import { TOKEN_WEIGHTS } from '../limits/limits-logic.js';
import { alertsToSend, budgetDay, evaluateBudget, firstHardBlock, matchProjectByCwd, toStatus, weightedUsage } from './budget-logic.js';

describe('byudjet kuni: Toshkent yarim kechasi (UTC+5)', () => {
  it('00:00 Toshkent = 19:00 UTC oldingi kun; chegarada kun almashadi', () => {
    const before = budgetDay(new Date('2026-11-14T18:59:59.999Z')); // 23:59:59.999 Toshkent, 14-noyabr
    expect(before.day).toBe('2026-11-14');
    expect(before.resetsAt.toISOString()).toBe('2026-11-14T19:00:00.000Z');
    const at = budgetDay(new Date('2026-11-14T19:00:00.000Z')); // 00:00:00 Toshkent, 15-noyabr
    expect(at.day).toBe('2026-11-15');
    expect(at.start.toISOString()).toBe('2026-11-14T19:00:00.000Z');
    expect(at.resetsAt.toISOString()).toBe('2026-11-15T19:00:00.000Z');
  });
  it('UTC yarim kechasi Toshkent kunini o\'zgartirmaydi (05:00 Toshkent)', () => {
    expect(budgetDay(new Date('2026-11-15T00:00:00Z')).day).toBe('2026-11-15');
    expect(budgetDay(new Date('2026-11-14T23:59:59Z')).day).toBe('2026-11-15');
  });
  it('yil chegarasi', () => {
    expect(budgetDay(new Date('2026-12-31T19:00:00Z')).day).toBe('2027-01-01');
    expect(budgetDay(new Date('2026-12-31T18:59:59Z')).day).toBe('2026-12-31');
  });
});

describe('vaznli token', () => {
  it('formula 3.1 limit kalibrlashi bilan bir xil (drift)', () => {
    expect(BUDGET_TOKEN_WEIGHTS).toEqual(TOKEN_WEIGHTS);
    expect(weightedUsage({ input: 100, output: 100, cacheRead: 100, cacheCreation: 100 })).toBe(100 + 500 + 10 + 125);
    expect(weightedUsage({ input: 0, output: 0, cacheRead: 1000, cacheCreation: 0 })).toBe(100);
  });
});

describe('evaluateBudget: chegaralar', () => {
  const e = (used: number, daily = 100_000, extra = 0) => evaluateBudget({ dailyTokens: daily, extra, used });
  it('79.99% ok, 80% soft, 99.99% soft, 100% hard, 150% hard', () => {
    expect(e(79_999).state).toBe('ok');
    expect(e(80_000).state).toBe('soft');
    expect(e(99_999).state).toBe('soft');
    expect(e(100_000).state).toBe('hard');
    expect(e(150_000)).toMatchObject({ state: 'hard', pct: 150 });
    expect(e(0)).toMatchObject({ state: 'ok', pct: 0 });
  });
  it('override chegarani oshiradi (qattiq -> yumshoq -> ok)', () => {
    expect(e(100_000, 100_000, 50_000)).toMatchObject({ effectiveLimit: 150_000, state: 'ok', pct: 66.7 });
    expect(e(125_000, 100_000, 50_000).state).toBe('soft');
    expect(e(150_000, 100_000, 50_000).state).toBe('hard');
  });
  it('minimal chegara va manfiy qiymatlar xavfsiz', () => {
    expect(BUDGET_LIMITS.minDailyTokens).toBeGreaterThan(0);
    expect(e(-5, 10_000, -1)).toMatchObject({ state: 'ok', pct: 0, effectiveLimit: 10_000 });
  });
});

describe('cwd -> loyiha', () => {
  const projects = [
    { id: 'a', path: '/work/app', key: 'github.com/acme/app', name: 'app' },
    { id: 'b', path: '/work/app/packages/web', key: 'github.com/acme/web', name: 'web' },
    { id: 'c', path: 'C:\\Users\\me\\proj', key: 'proj-c', name: 'proj' },
    { id: 'd', path: '/work/app2', key: 'k-d', name: 'app2' },
  ];
  it('aniq yo\'l, ichki papka, eng uzun mos yo\'l yutadi; qo\'shni prefiks mos kelmaydi', () => {
    expect(matchProjectByCwd('/work/app', projects)?.id).toBe('a');
    expect(matchProjectByCwd('/work/app/src/x', projects)?.id).toBe('a');
    expect(matchProjectByCwd('/work/app/packages/web/src', projects)?.id).toBe('b');
    expect(matchProjectByCwd('/work/app2/x', projects)?.id).toBe('d');
    expect(matchProjectByCwd('/work/application', projects)).toBeNull();
    expect(matchProjectByCwd('/other', projects)).toBeNull();
  });
  it('Windows yo\'l va oxirgi slash/harf registri', () => {
    expect(matchProjectByCwd('c:\\users\\me\\PROJ\\src', projects)?.id).toBe('c');
    expect(matchProjectByCwd('/work/app/', projects)?.id).toBe('a');
  });
});

describe('darvoza va ogohlantirishlar', () => {
  const st = (kind: 'project' | 'machine', used: number) => toStatus({ scopeKind: kind, scopeKey: `${kind}-k`, label: `${kind}-L`, dailyTokens: 10_000, extra: 0, used, autoStop: false });
  it('qattiq bo\'lmasa null; loyiha mashinadan oldin; xabar o\'zbekcha', () => {
    expect(firstHardBlock([st('project', 5000), st('machine', 7000)])).toBeNull();
    const b = firstHardBlock([st('machine', 10_000), st('project', 12_000)]);
    expect(b).toMatchObject({ scopeKind: 'project', used: 12_000, limit: 10_000 });
    expect(b?.message).toBe(budgetExceededMessage({ scopeKind: 'project', label: 'project-L', used: 12_000, limit: 10_000 }));
    expect(b?.message).toContain('Kunlik byudjet tugadi');
    expect(b?.message).toContain('12 000 / 10 000');
    expect(b?.message).toContain('00:00');
  });
  it('alertsToSend: bir daraja bir marta; hard soft\'ni ham belgilaydi', () => {
    expect(alertsToSend('ok', new Set())).toEqual({ send: null, mark: [] });
    expect(alertsToSend('soft', new Set())).toEqual({ send: 'soft', mark: ['soft'] });
    expect(alertsToSend('soft', new Set(['soft']))).toEqual({ send: null, mark: [] });
    expect(alertsToSend('hard', new Set())).toEqual({ send: 'hard', mark: ['soft', 'hard'] });
    expect(alertsToSend('hard', new Set(['soft']))).toEqual({ send: 'hard', mark: ['hard'] });
    expect(alertsToSend('hard', new Set(['soft', 'hard']))).toEqual({ send: null, mark: [] });
    expect(alertsToSend('soft', new Set(['hard']))).toEqual({ send: null, mark: [] });
  });
});
