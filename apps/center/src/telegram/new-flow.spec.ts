import { describe, expect, it } from 'vitest';
import { FLOW_TTL_MS, FlowStore, PickRegistry, RateGate, availableModes, isStartable, parseSessionArg, parseTypedPath, validTaskText } from './new-flow.js';

describe('new-flow (sof mantiq)', () => {
  it('FlowStore: 10 daqiqadan keyin suhbat yo\'qoladi, "tugagan" belgisi bir marta', () => {
    const s = new FlowStore();
    s.start('1', 0);
    expect(s.get('1', FLOW_TTL_MS)).not.toBeNull(); // chegarada tirik, touch qiladi
    expect(s.get('1', FLOW_TTL_MS + FLOW_TTL_MS + 1)).toBeNull();
    expect(s.consumeExpired('1')).toBe(true);
    expect(s.consumeExpired('1')).toBe(false);
  });

  it('PickRegistry: ref faqat o\'z chati uchun va muddati ichida', () => {
    const r = new PickRegistry();
    const ref = r.issue('1', { kind: 'cancel' }, 'f', 0, 1000);
    expect(r.resolve('1', ref, 500)?.value).toEqual({ kind: 'cancel' });
    expect(r.resolve('2', ref, 500)).toBeNull();
    expect(r.resolve('1', ref, 1001)).toBeNull();
  });

  it('RateGate: oynada max ta, keyin yana ruxsat', () => {
    const g = new RateGate(2, 1000);
    expect([g.allow('1', 0), g.allow('1', 1), g.allow('1', 2)]).toEqual([true, true, false]);
    expect(g.allow('1', 1500)).toBe(true);
    expect(g.allow('2', 2)).toBe(true);
  });

  it('isStartable va availableModes', () => {
    const control = { enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 1, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false };
    expect(isStartable({ online: true, control })).toBe(true);
    expect(isStartable({ online: false, control })).toBe(false);
    expect(isStartable({ online: true, control: null })).toBe(false);
    expect(isStartable({ online: true, control: { ...control, allowStart: false } })).toBe(false);
    expect(isStartable({ online: true, control: { ...control, centerKeyPinned: false } })).toBe(false);
    expect(isStartable({ online: true, control: { ...control, runningAsRoot: true } })).toBe(false);
    expect(availableModes(false)).toEqual(['default', 'acceptEdits', 'plan']);
    expect(availableModes(true)).toContain('auto');
  });

  it('parseTypedPath / validTaskText / parseSessionArg', () => {
    expect(parseTypedPath('  /Users/a/b ')).toEqual({ ok: true, path: '/Users/a/b' });
    expect(parseTypedPath('C:\\proj')).toEqual({ ok: true, path: 'C:\\proj' });
    expect(parseTypedPath('rel/x')).toMatchObject({ ok: false, reason: 'not_absolute' });
    expect(parseTypedPath('/a\nb')).toMatchObject({ ok: false, reason: 'bad_chars' });
    expect(parseTypedPath('  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(validTaskText('x'.repeat(16_001))).toMatchObject({ ok: false, reason: 'too_long' });
    expect(validTaskText(' hi ')).toEqual({ ok: true, text: 'hi' });
    expect(parseSessionArg('2')).toEqual({ kind: 'index', n: 2 });
    expect(parseSessionArg('ABCDEF12')).toEqual({ kind: 'prefix', prefix: 'abcdef12' });
    expect(parseSessionArg('zz')).toEqual({ kind: 'invalid' });
  });
});
