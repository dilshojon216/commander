import { describe, expect, it } from 'vitest';
import { IdempotencyKeySchema } from '@commander/contracts';
import { TriggerError, classifyCommand, confirmationFor, decideFire, fireKey, nextAfterFire, scheduleFor } from './queue-logic.js';
import type { FireContext } from './queue-logic.js';

const now = new Date('2026-11-13T10:00:00Z');

describe('confirmationFor (yaratishdagi step-up)', () => {
  it('istisno qurilma (dashboard) o\'tadi, auto o\'tmaydi', () => {
    expect(confirmationFor({ mode: 'default', exemptDevice: true, actorKind: 'client', inline: false })).toBe('exempt_device');
    expect(confirmationFor({ mode: 'acceptEdits', exemptDevice: true, actorKind: 'client', inline: false })).toBe('exempt_device');
    expect(confirmationFor({ mode: 'auto', exemptDevice: true, actorKind: 'client', inline: false })).toBeNull();
  });
  it('istisnosiz qurilma rad; Telegram inline tasdiq o\'tadi (auto ham)', () => {
    expect(confirmationFor({ mode: 'default', exemptDevice: false, actorKind: 'client', inline: false })).toBeNull();
    expect(confirmationFor({ mode: 'auto', exemptDevice: false, actorKind: 'telegram', inline: true })).toBe('telegram_inline');
    // inline bayrog'i faqat telegram aktori uchun hisobga olinadi
    expect(confirmationFor({ mode: 'default', exemptDevice: false, actorKind: 'client', inline: true })).toBeNull();
    expect(confirmationFor({ mode: 'default', exemptDevice: false, actorKind: 'telegram', inline: false })).toBeNull();
  });
});

describe('scheduleFor', () => {
  it('now / at / machine_idle / limit_reset', () => {
    expect(scheduleFor({ type: 'now' }, now, null)).toEqual({ status: 'queued', nextRunAt: now });
    expect(scheduleFor({ type: 'at', at: '2026-11-14T00:00:00Z' }, now, null).nextRunAt!.toISOString()).toBe('2026-11-14T00:00:00.000Z');
    expect(scheduleFor({ type: 'machine_idle' }, now, null).status).toBe('waiting_trigger');
    const reset = new Date('2026-11-13T12:00:00Z');
    expect(scheduleFor({ type: 'limit_reset', window: '5h' }, now, reset).nextRunAt).toEqual(reset);
    expect(scheduleFor({ type: 'limit_reset', window: '7d' }, now, null).nextRunAt).toBeNull();
  });
  it('at: o\'tmish va juda uzoq rad', () => {
    expect(() => scheduleFor({ type: 'at', at: '2026-11-13T09:00:00Z' }, now, null)).toThrow(TriggerError);
    expect(() => scheduleFor({ type: 'at', at: '2027-06-01T00:00:00Z' }, now, null)).toThrow(/days ahead/);
  });
  it('cron: keyingi chiqish Toshkent bo\'yicha; yaroqsiz rad', () => {
    expect(scheduleFor({ type: 'cron', cron: '0 2 * * *', timezone: 'Asia/Tashkent' }, now, null).nextRunAt!.toISOString()).toBe('2026-11-13T21:00:00.000Z');
    expect(() => scheduleFor({ type: 'cron', cron: '*/5 * * * *', timezone: 'Asia/Tashkent' }, now, null)).toThrow(TriggerError);
    expect(nextAfterFire({ type: 'cron', cron: '0 2 * * *', timezone: 'Asia/Tashkent' }, new Date('2026-11-13T21:00:05Z'))!.toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(nextAfterFire({ type: 'now' }, now)).toBeNull();
  });
});

const ctx = (o: Partial<FireContext> = {}): FireContext => ({
  lockdown: false, machineOnline: true, activeRemote: 0, maxConcurrent: 2, limitExhausted: false, attempts: 0, maxAttempts: 6,
  isCron: false, machineBusy: false, triggerType: 'at', startingNow: 0, maxStartingNow: 2, ...o,
});

describe('decideFire', () => {
  it('yo\'l ochiq => fire', () => expect(decideFire(ctx())).toEqual({ kind: 'fire' }));
  it('lockdown => kechiktirish, urinish hisoblanmaydi', () => {
    expect(decideFire(ctx({ lockdown: true }))).toMatchObject({ kind: 'defer', code: 'lockdown', countAttempt: false });
  });
  it('offline: urinish hisoblanadi; limitda one-shot fail, cron skip', () => {
    expect(decideFire(ctx({ machineOnline: false }))).toMatchObject({ kind: 'defer', code: 'machine_offline', countAttempt: true });
    expect(decideFire(ctx({ machineOnline: false, attempts: 5 }))).toEqual({ kind: 'fail', code: 'machine_offline' });
    expect(decideFire(ctx({ machineOnline: false, attempts: 5, isCron: true }))).toEqual({ kind: 'skip_occurrence', code: 'machine_offline' });
  });
  it('maxConcurrentStarted, limit tugayapti, machine_idle band, markaz chegarasi', () => {
    expect(decideFire(ctx({ activeRemote: 2 }))).toMatchObject({ code: 'too_many_sessions' });
    expect(decideFire(ctx({ maxConcurrent: null, activeRemote: 9 }))).toEqual({ kind: 'fire' });
    expect(decideFire(ctx({ limitExhausted: true }))).toMatchObject({ code: 'limit_exhausted' });
    expect(decideFire(ctx({ triggerType: 'machine_idle', machineBusy: true }))).toMatchObject({ code: 'machine_busy' });
    expect(decideFire(ctx({ startingNow: 2 }))).toMatchObject({ code: 'queue_busy' });
  });
});

describe('classifyCommand / fireKey', () => {
  it('natija tasnifi', () => {
    expect(classifyCommand('done', null)).toEqual({ kind: 'started' });
    expect(classifyCommand('running', null)).toEqual({ kind: 'pending' });
    expect(classifyCommand('rejected', 'machine_offline')).toEqual({ kind: 'retry', code: 'machine_offline' });
    expect(classifyCommand('failed', 'agent_timeout')).toEqual({ kind: 'retry', code: 'agent_timeout' });
    expect(classifyCommand('rejected', 'policy_disabled')).toEqual({ kind: 'failed', code: 'policy_disabled' });
    expect(classifyCommand('failed', 'cwd_not_allowed')).toEqual({ kind: 'failed', code: 'cwd_not_allowed' });
    expect(classifyCommand('expired', null)).toEqual({ kind: 'failed', code: 'expired' });
  });
  it('kalit Idempotency-Key formatiga mos', () => {
    expect(IdempotencyKeySchema.safeParse(fireKey('11111111-1111-4111-8111-111111111111', 3)).success).toBe(true);
  });
});
