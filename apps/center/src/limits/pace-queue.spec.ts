import { describe, expect, it } from 'vitest';
import { QUEUE_LIMITS } from '@commander/contracts';
import { DEFER_MS, classifyCommand, decideFire } from '../queue/queue-logic.js';
import type { FireContext } from '../queue/queue-logic.js';

const ctx = (over: Partial<FireContext> = {}): FireContext => ({
  lockdown: false, machineOnline: true, activeRemote: 0, maxConcurrent: 3, limitExhausted: false, attempts: 0, maxAttempts: QUEUE_LIMITS.maxAttempts, isCron: false, machineBusy: false, triggerType: 'now', startingNow: 0, maxStartingNow: 10, ...over,
});

describe('navbat: haftalik tezlik (6.12)', () => {
  it('ulush tugaganda kutadi (urinish sanalmaydi, muvaffaqiyatsiz emas); aks holda ishga tushadi', () => {
    expect(decideFire(ctx({ paceExceeded: true }))).toEqual({ kind: 'defer', code: 'weekly_pace_exceeded', delayMs: DEFER_MS.exhausted, countAttempt: false });
    expect(decideFire(ctx({ paceExceeded: false }))).toEqual({ kind: 'fire' });
  });
  it('lockdown/oflayn tezlikdan oldin; takroriy element o\'tkazib yuborilmaydi', () => {
    expect(decideFire(ctx({ paceExceeded: true, lockdown: true }))).toMatchObject({ code: 'lockdown' });
    expect(decideFire(ctx({ paceExceeded: true, machineOnline: false }))).toMatchObject({ code: 'machine_offline' });
    expect(decideFire(ctx({ paceExceeded: true, isCron: true, triggerType: 'cron' }))).toMatchObject({ kind: 'defer', code: 'weekly_pace_exceeded' });
  });
  it('tasodifan rad etilgan weekly_pace_exceeded buyrug\'i qayta urinish (muvaffaqiyatsiz emas)', () => {
    expect(classifyCommand('rejected', 'weekly_pace_exceeded')).toEqual({ kind: 'retry', code: 'weekly_pace_exceeded' });
  });
});
