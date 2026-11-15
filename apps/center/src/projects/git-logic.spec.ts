import { describe, expect, it } from 'vitest';
import { precheckCommand, needsStepUp } from '../commands/control-logic.js';
import { ciPollKey, gitHttpStatus, isValidKey, resolveSessionBase } from './git-logic.js';
import { computeTaskCommitLinks, freshCommitShas } from './task-commits.js';

describe('resolveSessionBase', () => {
  it('SessionStart HEAD > snapshot > HEAD', () => {
    expect(resolveSessionBase({ startHeadSha: 'a'.repeat(40), snapshotHeadSha: 'b'.repeat(40) })).toEqual({ base: 'a'.repeat(40), source: 'session_start' });
    expect(resolveSessionBase({ startHeadSha: null, snapshotHeadSha: 'b'.repeat(40) })).toEqual({ base: 'b'.repeat(40), source: 'snapshot' });
    expect(resolveSessionBase({ startHeadSha: null, snapshotHeadSha: null })).toEqual({ base: 'HEAD', source: 'head' });
  });
});

describe('ciPollKey', () => {
  it('bir oyna ichida bir xil, boshqa oynada boshqa; Idempotency-Key sxemasiga mos', () => {
    const p = '7e57c0de-1111-4222-8333-444455556666';
    const w = 300_000;
    expect(ciPollKey(p, 'feat/x', 1_000, w)).toBe(ciPollKey(p, 'feat/x', 299_000, w));
    expect(ciPollKey(p, 'feat/x', 1_000, w)).not.toBe(ciPollKey(p, 'feat/x', 301_000, w));
    expect(ciPollKey(p, 'feat/x', 1_000, w)).not.toBe(ciPollKey(p, 'feat/y', 1_000, w));
    for (const b of ['feat/x', 'a'.repeat(200), 'x+y']) expect(isValidKey(ciPollKey(p, b, 1_000, w)), b).toBe(true);
  });
});

describe('gitHttpStatus', () => {
  it('xato kodlari -> HTTP', () => {
    expect(gitHttpStatus('lockdown')).toBe(403);
    expect(gitHttpStatus('action_not_allowed')).toBe(403);
    for (const c of ['machine_offline', 'agent_outdated', 'not_a_git_repo', 'gh_unavailable', 'dirty_worktree']) expect(gitHttpStatus(c)).toBe(409);
    expect(gitHttpStatus('base_invalid')).toBe(422);
    expect(gitHttpStatus('agent_timeout')).toBe(504);
    expect(gitHttpStatus('weird')).toBe(502);
    expect(gitHttpStatus(null)).toBe(502);
  });
});

describe('commit -> vazifa (sof qism)', () => {
  const c = (sha: string, subject: string) => ({ sha, subject, author: 'a', ts: 0 });
  it('freshCommitShas: oldingi snapshot yo\'q bo\'lsa bo\'sh; aks holda yangi shalar', () => {
    expect(freshCommitShas([{ sha: 'a' }], [])).toEqual(new Set());
    expect(freshCommitShas([{ sha: 'a' }, { sha: 'b' }], [[{ sha: 'b' }]])).toEqual(new Set(['a']));
  });
  it('branch taxmini faqat yangi commit va mavjud vazifaga', () => {
    const links = computeTaskCommitLinks({ commits: [c('n', 'wip'), c('o', 'old')], branch: 'feat/3.5-x', taskKeys: new Set(['3.5']), previous: [[{ sha: 'o' }]] });
    expect(links).toEqual([{ sha: 'n', taskKey: '3.5', source: 'branch' }]);
    expect(computeTaskCommitLinks({ commits: [c('n', 'wip')], branch: 'feat/3.5-x', taskKeys: new Set(['9.9']), previous: [[]] })).toEqual([]);
    expect(computeTaskCommitLinks({ commits: [c('n', 'wip')], branch: 'main', taskKeys: new Set(['3.5']), previous: [[]] })).toEqual([]);
  });
});

describe('control-logic: git buyruqlari', () => {
  const ctl = (over: Record<string, unknown> = {}) => ({
    enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1,
    centerKeyPinned: true, runningAsRoot: false, projectOps: true, allowProjectRead: true, allowProjectWrite: true, gitOps: true, ...over,
  });
  const pre = (type: 'project.diff' | 'project.open_pr' | 'project.ci_status', control: ReturnType<typeof ctl>) => precheckCommand({ type, machineOnline: true, control: control as never, machineOs: 'darwin' });
  it('gitOps e\'lon qilinmagan agentd: agent_outdated', () => {
    for (const t of ['project.diff', 'project.open_pr', 'project.ci_status'] as const) expect(pre(t, ctl({ gitOps: undefined }))).toMatchObject({ code: 'agent_outdated' });
  });
  it('diff/ci o\'qish ruxsatiga, PR yozish ruxsatiga bog\'liq', () => {
    expect(pre('project.diff', ctl())).toBeNull();
    expect(pre('project.diff', ctl({ allowProjectRead: false }))).toMatchObject({ code: 'action_not_allowed' });
    expect(pre('project.ci_status', ctl({ allowProjectRead: false }))).toMatchObject({ code: 'action_not_allowed' });
    expect(pre('project.open_pr', ctl({ allowProjectWrite: false }))).toMatchObject({ code: 'action_not_allowed' });
    expect(pre('project.open_pr', ctl({ allowProjectRead: false }))).toBeNull(); // PR faqat yozish ruxsatini talab qiladi
  });
  it('step-up: faqat PR ochish', () => {
    expect(needsStepUp('project.open_pr')).toBe(true);
    expect(needsStepUp('project.diff')).toBe(false);
    expect(needsStepUp('project.ci_status')).toBe(false);
  });
});
