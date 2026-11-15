import { applyEvent, clampToNow, isOlderThanCurrentStatus, projectFromCwd } from './session-state.js';
import type { EventInput, SessionState } from './session-state.js';

const t0 = new Date('2026-01-01T10:00:00.000Z');
const t1 = new Date('2026-01-01T10:05:00.000Z');
const t2 = new Date('2026-01-01T10:10:00.000Z');

const input = (over: Partial<EventInput> = {}): EventInput => ({
  host: 'mac-1',
  sessionId: 's-1',
  cwd: '/Users/me/work/commander',
  status: 'working',
  message: null,
  notificationType: null,
  ...over,
});

describe('projectFromCwd', () => {
  it.each([
    ['/Users/me/work/commander', 'commander'],
    ['/Users/me/work/commander/', 'commander'],
    ['C:\\Users\\me\\proj', 'proj'],
    ['/', '/'],
    ['single', 'single'],
  ])('%s -> %s', (cwd, expected) => {
    expect(projectFromCwd(cwd)).toBe(expected);
  });
});

describe('applyEvent', () => {
  it('creates a new session: started_at = status_since = last_seen_at = now', () => {
    const s = applyEvent(null, input(), t0);
    expect(s).toMatchObject({
      project: 'commander',
      status: 'working',
      startedAt: t0,
      statusSince: t0,
      lastSeenAt: t0,
      endedAt: null,
    });
  });

  it('keeps status_since when the same status repeats, but bumps last_seen_at', () => {
    const first = applyEvent(null, input(), t0);
    const second = applyEvent(first, input(), t1);
    expect(second.statusSince).toEqual(t0);
    expect(second.lastSeenAt).toEqual(t1);
    expect(second.startedAt).toEqual(t0);
  });

  it('moves status_since when the status changes', () => {
    const first = applyEvent(null, input(), t0);
    const second = applyEvent(first, input({ status: 'waiting', message: 'Needs approval', notificationType: 'permission_prompt' }), t1);
    expect(second.status).toBe('waiting');
    expect(second.statusSince).toEqual(t1);
    expect(second.startedAt).toEqual(t0);
    expect(second.message).toBe('Needs approval');
    expect(second.notificationType).toBe('permission_prompt');
  });

  it('clears the message when a later event carries none', () => {
    const waiting = applyEvent(null, input({ status: 'waiting', message: 'Needs approval' }), t0);
    const working = applyEvent(waiting, input({ status: 'working' }), t1);
    expect(working.message).toBeNull();
  });

  it('sets ended_at on ended, keeps the first one on repeats, and clears it on resume', () => {
    const working = applyEvent(null, input(), t0);
    const ended = applyEvent(working, input({ status: 'ended' }), t1);
    expect(ended.endedAt).toEqual(t1);
    expect(ended.statusSince).toEqual(t1);

    const endedAgain = applyEvent(ended, input({ status: 'ended' }), t2);
    expect(endedAgain.endedAt).toEqual(t1);
    expect(endedAgain.statusSince).toEqual(t1);

    const resumed = applyEvent(endedAgain, input({ status: 'working' }), t2);
    expect(resumed.endedAt).toBeNull();
    expect(resumed.statusSince).toEqual(t2);
  });

  it('refreshes cwd/project when the session moves directory', () => {
    const first = applyEvent(null, input(), t0);
    const second = applyEvent(first, input({ cwd: '/tmp/other' }), t1);
    expect(second.cwd).toBe('/tmp/other');
    expect(second.project).toBe('other');
  });

  it('does not mutate the existing row', () => {
    const existing: SessionState = applyEvent(null, input(), t0);
    const snapshot = { ...existing };
    applyEvent(existing, input({ status: 'done' }), t1);
    expect(existing).toEqual(snapshot);
  });
});

describe('agent channel additions', () => {
  it('awaiting_approval is a normal status transition', () => {
    const first = applyEvent(null, input(), t0);
    const next = applyEvent(first, input({ status: 'awaiting_approval', message: 'Bash: ls' }), t1);
    expect(next.status).toBe('awaiting_approval');
    expect(next.statusSince).toEqual(t1);
  });

  it('stores end_reason only while ended and clears it on resume', () => {
    const working = applyEvent(null, input(), t0);
    const ended = applyEvent(working, input({ status: 'ended', endReason: 'vanished' }), t1);
    expect(ended.endReason).toBe('vanished');
    const endedAgain = applyEvent(ended, input({ status: 'ended' }), t2);
    expect(endedAgain.endReason).toBe('vanished');
    const resumed = applyEvent(endedAgain, input({ status: 'working' }), t2);
    expect(resumed.endReason).toBeNull();
  });

  it('keeps the last transcript path when an event carries none', () => {
    const a = applyEvent(null, input({ transcriptPath: '/t/a.jsonl' }), t0);
    const b = applyEvent(a, input(), t1);
    expect(b.transcriptPath).toBe('/t/a.jsonl');
    expect(applyEvent(b, input({ transcriptPath: '/t/b.jsonl' }), t2).transcriptPath).toBe('/t/b.jsonl');
  });

  it('an event clears stale_since (the machine is alive)', () => {
    const stale = { ...applyEvent(null, input(), t0), staleSince: t1 };
    expect(applyEvent(stale, input(), t2).staleSince).toBeNull();
  });

  it('last_seen_at never moves backwards (heartbeat may have advanced it)', () => {
    const s = { ...applyEvent(null, input(), t0), lastSeenAt: t2 };
    expect(applyEvent(s, input(), t1).lastSeenAt).toEqual(t2);
  });

  it('isOlderThanCurrentStatus: strictly older than status_since only', () => {
    const s = applyEvent(null, input(), t1);
    expect(isOlderThanCurrentStatus(null, t0)).toBe(false);
    expect(isOlderThanCurrentStatus(s, t0)).toBe(true);
    expect(isOlderThanCurrentStatus(s, t1)).toBe(false);
    expect(isOlderThanCurrentStatus(s, t2)).toBe(false);
  });

  it('clampToNow pulls future timestamps back to the server time', () => {
    expect(clampToNow(t2.getTime(), t1)).toEqual(t1);
    expect(clampToNow(t0.getTime(), t1)).toEqual(t0);
  });
});
