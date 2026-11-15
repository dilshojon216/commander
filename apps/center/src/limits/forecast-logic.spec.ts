import { describe, expect, it } from 'vitest';
import type { LimitWindowView } from '@commander/contracts';
import { decideForecastAlert, exhaustsWithin, forecastWindow } from './forecast-logic.js';

const now = new Date('2026-11-13T10:00:00.000Z');
const view = (o: Partial<LimitWindowView> = {}): LimitWindowView => ({
  usedPct: 70,
  resetsAt: '2026-11-13T13:00:00.000Z',
  observedAt: '2026-11-13T09:59:30.000Z',
  source: 'official',
  stale: false,
  ageSeconds: 30,
  reset: false,
  observedByMachineId: null,
  anchor: null,
  calibration: { coefficient: 0.00001, samples: 6 },
  ...o,
});

describe('forecastWindow', () => {
  it('5h: 30 daqiqada 3% => 6%/soat, 30% qoldi => 5 soat; reset 3 soatda => reset oldin', () => {
    const f = forecastWindow({ kind: 'fiveHour', now, view: view(), basisWeightedTokens: 300_000 });
    expect(f).not.toBeNull();
    expect(f!.ratePctPerHour).toBe(6);
    expect(f!.beforeReset).toBe(false);
    expect(f!.confidence).toBe('high');
    expect(Date.parse(f!.exhaustsAt) - now.getTime()).toBeCloseTo(5 * 3_600_000, -3);
  });

  it('tez sarf: reset\'dan oldin tugaydi', () => {
    const f = forecastWindow({ kind: 'fiveHour', now, view: view({ usedPct: 90 }), basisWeightedTokens: 1_000_000 });
    expect(f!.ratePctPerHour).toBe(20);
    expect(f!.beforeReset).toBe(true);
    expect(f!.exhaustsAt).toBe('2026-11-13T10:30:00.000Z');
  });

  it('haftalik: 24 soatlik oraliq', () => {
    const f = forecastWindow({ kind: 'sevenDay', now, view: view({ usedPct: 50, resetsAt: '2026-11-17T00:00:00.000Z' }), basisWeightedTokens: 2_400_000 });
    expect(f!.basisMinutes).toBe(1440);
    expect(f!.ratePctPerHour).toBe(1);
    expect(f!.beforeReset).toBe(true); // 50 soat < ~86 soat
  });

  it('ma\'lumot yetarli emas => null', () => {
    expect(forecastWindow({ kind: 'fiveHour', now, view: null, basisWeightedTokens: 1e6 })).toBeNull();
    expect(forecastWindow({ kind: 'fiveHour', now, view: view({ calibration: { coefficient: null, samples: 0 } }), basisWeightedTokens: 1e6 })).toBeNull();
    expect(forecastWindow({ kind: 'fiveHour', now, view: view(), basisWeightedTokens: 0 })).toBeNull();
    expect(forecastWindow({ kind: 'fiveHour', now, view: view(), basisWeightedTokens: 1000 })).toBeNull(); // 0.01% < 0.25%
  });

  it('ishonch: kam namuna, eskirgan, reset', () => {
    expect(forecastWindow({ kind: 'fiveHour', now, view: view({ calibration: { coefficient: 1e-5, samples: 1 } }), basisWeightedTokens: 3e5 })!.confidence).toBe('low');
    expect(forecastWindow({ kind: 'fiveHour', now, view: view({ calibration: { coefficient: 1e-5, samples: 3 } }), basisWeightedTokens: 3e5 })!.confidence).toBe('medium');
    expect(forecastWindow({ kind: 'fiveHour', now, view: view({ stale: true }), basisWeightedTokens: 3e5 })!.confidence).toBe('medium');
    expect(forecastWindow({ kind: 'fiveHour', now, view: view({ reset: true, source: 'estimate' }), basisWeightedTokens: 3e5 })!.confidence).toBe('low');
  });

  it('100% dan oshgan: hozir tugagan', () => {
    const f = forecastWindow({ kind: 'fiveHour', now, view: view({ usedPct: 120 }), basisWeightedTokens: 3e5 });
    expect(f!.exhaustsAt).toBe(now.toISOString());
  });
});

describe('exhaustsWithin / decideForecastAlert', () => {
  const soon = (): LimitWindowView => view({ usedPct: 90, forecast: forecastWindow({ kind: 'fiveHour', now, view: view({ usedPct: 90 }), basisWeightedTokens: 1_000_000 }) });

  it('exhaustsWithin', () => {
    expect(exhaustsWithin(soon(), now, 35 * 60_000)).toBe(true);
    expect(exhaustsWithin(soon(), now, 10 * 60_000)).toBe(false);
    expect(exhaustsWithin(view({ usedPct: 100 }), now, 1)).toBe(true);
    expect(exhaustsWithin(null, now, 1)).toBe(false);
  });

  it('30 daqiqa ichida: bir marta, oyna bo\'yicha', () => {
    const a = decideForecastAlert(soon(), {}, now);
    expect(a.alert).not.toBeNull();
    expect(decideForecastAlert(soon(), a.state, new Date(now.getTime() + 60_000)).alert).toBeNull();
    const nextWindow = { ...soon(), resetsAt: '2026-11-13T18:00:00.000Z', forecast: { ...soon().forecast!, resetsAt: '2026-11-13T18:00:00.000Z' } } as LimitWindowView;
    expect(decideForecastAlert(nextWindow, a.state, now).alert).not.toBeNull();
  });

  it('uzoq, past ishonch, reset-taxmin, 100% => jim', () => {
    const far = view({ forecast: forecastWindow({ kind: 'fiveHour', now, view: view(), basisWeightedTokens: 3e5 }) });
    expect(decideForecastAlert(far, {}, now).alert).toBeNull();
    const low = soon();
    low.forecast = { ...low.forecast!, confidence: 'low' };
    expect(decideForecastAlert(low, {}, now).alert).toBeNull();
    expect(decideForecastAlert({ ...soon(), reset: true }, {}, now).alert).toBeNull();
    expect(decideForecastAlert({ ...soon(), usedPct: 100 }, {}, now).alert).toBeNull();
    expect(decideForecastAlert(null, {}, now).alert).toBeNull();
  });
});
