import { describe, expect, it } from 'vitest';
import { DEFAULT_PACE_SETTINGS } from '@commander/contracts';
import type { WeeklyPace } from '@commander/contracts';
import { comma1, formatPaceAlert, formatPaceLines, paceForecastText, paceShareText } from './pace-format.js';
import { formatLimits } from '../telegram/telegram-format.js';

const pace = (over: Partial<WeeklyPace> = {}): WeeklyPace => ({
  dayStartPct: 20, dayStartFrom: 'prev_sample', allowancePct: 18, usedTodayPct: 9.8, pctOfAllowance: 54.4, expectedPct: 50, currentPct: 29.8, onTrack: true, status: 'on_track',
  exhaustAt: null, exhaustBeforeReset: null, resetsAt: '2026-11-15T13:00:00.000Z', windowStartsAt: '2026-11-08T13:00:00.000Z', dayStartsAt: '2026-11-11T19:00:00.000Z',
  remainingDays: 4.44, source: 'official', stale: false, enabled: true, softPct: DEFAULT_PACE_SETTINGS.softPct, hardPct: DEFAULT_PACE_SETTINGS.hardPct, enforce: false,
  overriddenToday: false, blocked: false, alertsToday: { soft: null, hard: null }, ...over,
});

describe('pace matnlari (Telegram)', () => {
  it('o\'nli vergul va ulush qatori', () => {
    expect(comma1(9.84)).toBe('9,8');
    expect(paceShareText(pace())).toBe('9,8% / 18,0% (54%)');
  });
  it('taxmin: ≈ belgisi va "taxmin, rasmiy emas"', () => {
    expect(paceShareText(pace({ source: 'estimate' }))).toBe('≈9,8% / ≈18,0% (54%)');
    expect(formatPaceLines(pace({ source: 'estimate', stale: true })).join('\n')).toContain('taxmin (rasmiy emas)');
    expect(formatPaceAlert(pace({ source: 'estimate' }), 'soft')).toContain('Manba: taxmin (rasmiy emas)');
    expect(formatPaceAlert(pace(), 'soft')).toContain('Manba: rasmiy');
  });
  it('bashorat: tugash vaqti + yangilanish; yetadigan bo\'lsa hafta oxirigacha', () => {
    const t = paceForecastText(pace({ exhaustAt: '2026-11-14T00:00:00.000Z', exhaustBeforeReset: true }))!;
    expect(t).toBe('shu tezlikda 14/11, 05:00 da tugaydi; yangilanish 15/11, 18:00');
    expect(paceForecastText(pace({ exhaustAt: '2026-11-20T00:00:00.000Z', exhaustBeforeReset: false }))).toContain('hafta oxirigacha yetadi');
    expect(paceForecastText(pace())).toBeNull();
  });
  it('holat matni va /limits ga qo\'shilishi', () => {
    expect(formatPaceLines(pace({ status: 'fast' })).join('\n')).toContain('tez ketmoqda');
    expect(formatPaceLines(pace({ status: 'exceeded', blocked: true, enforce: true })).join('\n')).toContain('ulush tugadi');
    expect(formatPaceLines(pace({ overriddenToday: true })).join('\n')).toContain('Bugun uchun ruxsat');
    const l = { computedAt: 'x', freshSeconds: 180, fiveHour: null, sevenDay: null };
    expect(formatLimits({ ...l, pace: pace() })).toContain('Bugungi ulush: <b>9,8% / 18,0% (54%)</b> · rejada');
    expect(formatLimits(l)).not.toContain('Bugungi ulush');
  });
  it('ogohlantirish: foiz, ulush, bashorat va yangilanish bir xabarda', () => {
    const t = formatPaceAlert(pace({ pctOfAllowance: 100.4, exhaustAt: '2026-11-14T00:00:00.000Z', exhaustBeforeReset: true, status: 'exceeded', enforce: true }), 'hard');
    expect(t).toContain('100%');
    expect(t).toContain('9,8% / 18,0%');
    expect(t).toContain('tugaydi; yangilanish');
    expect(t).toContain('kechiktiriladi');
  });
});
