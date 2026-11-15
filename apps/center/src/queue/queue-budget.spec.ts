import { describe, expect, it } from 'vitest';
import { QUEUE_LIMITS } from '@commander/contracts';
import { DEFER_MS, classifyCommand, decideFire } from './queue-logic.js';
import type { FireContext } from './queue-logic.js';

const ctx = (over: Partial<FireContext> = {}): FireContext => ({
  lockdown: false, machineOnline: true, activeRemote: 0, maxConcurrent: 3, limitExhausted: false, attempts: 0, maxAttempts: QUEUE_LIMITS.maxAttempts, isCron: false, machineBusy: false, triggerType: 'now', startingNow: 0, maxStartingNow: 10, ...over,
});

describe('navbat: kunlik byudjet (6.11)', () => {
  it('qattiq chegarada kutadi (urinish sanalmaydi, element yo\'qolmaydi); byudjet yo\'q/ok bo\'lsa ishga tushadi', () => {
    expect(decideFire(ctx({ budgetExceeded: true }))).toEqual({ kind: 'defer', code: 'budget_exceeded', delayMs: DEFER_MS.exhausted, countAttempt: false });
    expect(decideFire(ctx({ budgetExceeded: false }))).toEqual({ kind: 'fire' });
    expect(decideFire(ctx())).toEqual({ kind: 'fire' });
  });
  it('lockdown/oflayn byudjetdan oldin; takroriy (cron) element ham o\'tkazib yuborilmaydi, kutadi', () => {
    expect(decideFire(ctx({ budgetExceeded: true, lockdown: true }))).toMatchObject({ code: 'lockdown' });
    expect(decideFire(ctx({ budgetExceeded: true, machineOnline: false }))).toMatchObject({ code: 'machine_offline' });
    expect(decideFire(ctx({ budgetExceeded: true, isCron: true, triggerType: 'cron' }))).toMatchObject({ kind: 'defer', code: 'budget_exceeded' });
  });
  it('tasodifan rad etilgan budget_exceeded buyrug\'i (zaxira darvoza) navbatda failed, qayta urinish emas', () => {
    expect(classifyCommand('rejected', 'budget_exceeded')).toEqual({ kind: 'failed', code: 'budget_exceeded' });
  });
});
