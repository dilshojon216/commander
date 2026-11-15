import { describe, expect, it } from 'vitest';
import type { BudgetStatus, BudgetsResponse } from '@commander/contracts';
import { bar, fmtWeighted, formatBudgetHardAlert, formatBudgetSoftAlert, formatBudgetsTelegram, tashkentClock } from './budget-format.js';

const s = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  scopeKind: 'project', scopeKey: 'k', label: 'My <app>', dailyTokens: 1_000_000, extraToday: 0, effectiveLimit: 1_000_000, usedToday: 850_000, pct: 85, state: 'soft', autoStop: false, ...over,
});

describe('Telegram byudjet formati', () => {
  it('vaznli token qisqartirish', () => {
    expect(fmtWeighted(999)).toBe('999');
    expect(fmtWeighted(84_300)).toBe('84.3k');
    expect(fmtWeighted(250_000)).toBe('250k');
    expect(fmtWeighted(1_250_000)).toBe('1.25M');
    expect(fmtWeighted(12_300_000)).toBe('12.3M');
    expect(fmtWeighted(-5)).toBe('0');
  });
  it('chiziq 0..100% va undan ortiq', () => {
    expect(bar(0)).toBe('░░░░░░░░░░');
    expect(bar(55)).toBe('██████░░░░');
    expect(bar(100)).toBe('██████████');
    expect(bar(250)).toBe('██████████');
  });
  it('/budget: bo\'sh holat; tartib hard -> soft -> ok; HTML escape; yangilanish vaqti Toshkent', () => {
    const empty: BudgetsResponse = { day: '2026-11-14', resetsAt: '2026-11-14T19:00:00.000Z', items: [] };
    expect(formatBudgetsTelegram(empty)[0]).toContain('belgilanmagan');
    const r: BudgetsResponse = { day: '2026-11-14', resetsAt: '2026-11-14T19:00:00.000Z', items: [s({ label: 'ok-one', state: 'ok', pct: 10, usedToday: 100_000 }), s({ label: 'hard-one', state: 'hard', pct: 120, usedToday: 1_200_000 }), s()] };
    const text = formatBudgetsTelegram(r, new Date('2026-11-14T17:30:00Z'))[0]!;
    expect(text.indexOf('hard-one')).toBeLessThan(text.indexOf('My &lt;app&gt;'));
    expect(text.indexOf('My &lt;app&gt;')).toBeLessThan(text.indexOf('ok-one'));
    expect(text).toContain('00:00 (Toshkent)');
    expect(text).toContain('1 soat 30 daq.');
    expect(text).not.toContain('<app>');
  });
  it('soft/hard ogohlantirish: tugma matni va avto-to\'xtatish izohi; ishlayotgan sessiya yo\'q', () => {
    expect(formatBudgetSoftAlert(s())).toContain('80%');
    expect(formatBudgetHardAlert(s({ state: 'hard', pct: 101 }), 2)).toContain("o'zi to'xtamaydi");
    expect(formatBudgetHardAlert(s({ state: 'hard', pct: 101, autoStop: true }), 2)).toContain("avto-to'xtatish yoqilgan");
    expect(formatBudgetHardAlert(s({ state: 'hard' }), 0)).toContain("Ishlayotgan sessiya yo'q");
  });
  it('Toshkent soati', () => {
    expect(tashkentClock(new Date('2026-11-14T19:00:00Z'))).toBe('00:00');
    expect(tashkentClock(new Date('2026-11-14T01:05:00Z'))).toBe('06:05');
  });
});
