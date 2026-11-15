import { describe, expect, it } from 'vitest';
import { APPROVAL_LIMITS } from '@commander/contracts';
import type { ApprovalStatus } from '@commander/contracts';
import { decideApproval, isTerminal, normalizeDeadline, sessionStatusAfter, statusForBehavior } from './approval-state.js';

const now = new Date('2026-11-13T10:00:00.000Z');
const future = new Date(now.getTime() + 60_000);
const past = new Date(now.getTime() - 1);
const A = 'device-a';
const B = 'device-b';

const pending = (deadline = future) => ({ status: 'pending' as ApprovalStatus, deadline, decidedByDeviceId: null });
const decided = (status: 'approved' | 'denied', by = A) => ({ status: status as ApprovalStatus, deadline: future, decidedByDeviceId: by });

describe('approval state machine', () => {
  it('first decision applies: allow -> approved, deny -> denied', () => {
    expect(decideApproval(pending(), { behavior: 'allow', deviceId: A, now, lockdown: false })).toEqual({ kind: 'apply', status: 'approved' });
    expect(decideApproval(pending(), { behavior: 'deny', deviceId: A, now, lockdown: false })).toEqual({ kind: 'apply', status: 'denied' });
  });

  it('a deadline in the past (even if the sweeper has not run yet) is expired, never applied', () => {
    expect(decideApproval(pending(past), { behavior: 'allow', deviceId: A, now, lockdown: false })).toEqual({ kind: 'expired' });
    expect(decideApproval(pending(now), { behavior: 'deny', deviceId: A, now, lockdown: false })).toEqual({ kind: 'expired' });
  });

  it('same device repeating the same decision is idempotent', () => {
    expect(decideApproval(decided('approved'), { behavior: 'allow', deviceId: A, now, lockdown: false })).toEqual({ kind: 'idempotent' });
    expect(decideApproval(decided('denied'), { behavior: 'deny', deviceId: A, now, lockdown: false })).toEqual({ kind: 'idempotent' });
  });

  it('a different decision, a different device, or a resolved request conflicts (first decision wins)', () => {
    expect(decideApproval(decided('approved'), { behavior: 'deny', deviceId: A, now, lockdown: false })).toEqual({ kind: 'conflict', current: 'approved' });
    expect(decideApproval(decided('approved'), { behavior: 'allow', deviceId: B, now, lockdown: false })).toEqual({ kind: 'conflict', current: 'approved' });
    for (const status of ['expired', 'cancelled'] as const) {
      expect(decideApproval({ status, deadline: future, decidedByDeviceId: null }, { behavior: 'deny', deviceId: A, now, lockdown: false })).toEqual({ kind: 'conflict', current: status });
    }
  });

  it('lockdown refuses remote allow but permits deny', () => {
    expect(decideApproval(pending(), { behavior: 'allow', deviceId: A, now, lockdown: true })).toEqual({ kind: 'lockdown_allow_refused' });
    expect(decideApproval(pending(), { behavior: 'deny', deviceId: A, now, lockdown: true })).toEqual({ kind: 'apply', status: 'denied' });
  });

  it('lockdown does not mask expiry or conflicts', () => {
    expect(decideApproval(pending(past), { behavior: 'allow', deviceId: A, now, lockdown: true })).toEqual({ kind: 'expired' });
    expect(decideApproval(decided('denied'), { behavior: 'allow', deviceId: A, now, lockdown: true })).toEqual({ kind: 'conflict', current: 'denied' });
  });

  it('terminal statuses and helpers', () => {
    expect(['pending', 'approved', 'denied', 'expired', 'cancelled'].map((s) => isTerminal(s as ApprovalStatus))).toEqual([false, true, true, true, true]);
    expect(statusForBehavior('allow')).toBe('approved');
    expect(statusForBehavior('deny')).toBe('denied');
  });

  it('session status after resolution: expired -> waiting (local dialog still open), others -> working', () => {
    expect(sessionStatusAfter('expired')).toBe('waiting');
    for (const s of ['approved', 'denied', 'cancelled'] as const) expect(sessionStatusAfter(s)).toBe('working');
  });

  it('deadline is capped to maxDeadlineMs and a past deadline is already expired', () => {
    const far = normalizeDeadline(now.getTime() + 24 * 3_600_000, now);
    expect(far.deadline.getTime()).toBe(now.getTime() + APPROVAL_LIMITS.maxDeadlineMs);
    expect(far.alreadyExpired).toBe(false);
    expect(normalizeDeadline(now.getTime() + 5_000, now)).toEqual({ deadline: new Date(now.getTime() + 5_000), alreadyExpired: false });
    expect(normalizeDeadline(now.getTime() - 1, now).alreadyExpired).toBe(true);
    expect(normalizeDeadline(now.getTime(), now).alreadyExpired).toBe(true);
  });
});
