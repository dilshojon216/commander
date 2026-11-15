import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '@commander/contracts';
import { mapHookToStatus, truncate } from './session-state.js';

const map = (event: string, last?: SessionStatus, notificationType?: string) => mapHookToStatus({ event, last, notificationType });

describe('mapHookToStatus (session-report.sh bilan bir xil mantiq)', () => {
  it('asosiy xaritalash', () => {
    expect(map('SessionStart')).toBe('idle');
    expect(map('UserPromptSubmit', 'idle')).toBe('working');
    expect(map('Stop', 'working')).toBe('done');
    expect(map('SessionEnd', 'done')).toBe('ended');
    expect(map('Notification', 'working', 'permission_prompt')).toBe('waiting');
  });

  it("PreToolUse faqat kutishdan keyin 'working'", () => {
    expect(map('PreToolUse', 'working')).toBeNull();
    expect(map('PreToolUse', 'idle')).toBeNull();
    expect(map('PreToolUse', undefined)).toBeNull();
    expect(map('PreToolUse', 'waiting')).toBe('working');
    expect(map('PreToolUse', 'awaiting_approval')).toBe('working');
  });

  it("tugagan sessiyadagi idle_prompt o'tkazib yuboriladi, boshqa Notification doim yuboriladi", () => {
    expect(map('Notification', 'done', 'idle_prompt')).toBeNull();
    expect(map('Notification', 'working', 'idle_prompt')).toBe('waiting');
    expect(map('Notification', 'done', 'permission_prompt')).toBe('waiting');
    // Notification takror kelsa ham yuboriladi (waiting -> waiting)
    expect(map('Notification', 'waiting', 'permission_prompt')).toBe('waiting');
  });

  it('bir xil holat takrori (Notification dan tashqari) yuborilmaydi', () => {
    expect(map('UserPromptSubmit', 'working')).toBeNull();
    expect(map('Stop', 'done')).toBeNull();
    expect(map('SessionStart', 'idle')).toBeNull();
  });

  it("ended'dan keyin holat yo'q deb hisoblanadi", () => {
    expect(map('SessionStart', 'ended')).toBe('idle');
    expect(map('PreToolUse', 'ended')).toBeNull();
  });

  it("noma'lum hodisa e'tiborsiz", () => {
    expect(map('PostToolUse', 'working')).toBeNull();
  });

  it('PermissionRequest -> awaiting_approval (takror yuborilmaydi); keyingi PreToolUse kutishni tugatadi', () => {
    expect(map('PermissionRequest', 'working')).toBe('awaiting_approval');
    expect(map('PermissionRequest', 'awaiting_approval')).toBeNull();
    expect(map('PreToolUse', 'awaiting_approval')).toBe('working');
  });
});

describe('truncate', () => {
  it('uzunlikni cheklaydi va bo\'shni undefined qiladi', () => {
    expect(truncate('a'.repeat(3000), 2000)).toHaveLength(2000);
    expect(truncate('x'.repeat(100), 64)).toHaveLength(64);
    expect(truncate('', 10)).toBeUndefined();
    expect(truncate(null, 10)).toBeUndefined();
    expect(truncate('ok', 10)).toBe('ok');
  });
});
