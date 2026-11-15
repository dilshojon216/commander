import { describe, expect, it } from 'vitest';
import { TMUX_SESSION_NAME_RE } from '@commander/contracts';
import type { AgentEntry } from './agents-full.js';
import { buildResumeShellCommand, classifyResumed, liveVerdict, psLineResumes, shellQuote, tmuxResumeName } from './resume-logic.js';
import { planCloseSteps, scrubTmuxEnv, tmuxSessionOfLabel } from './tmux.js';

const SID = 'a1b97ff9-9114-4e80-8eec-42d325423876';
const e = (over: Partial<AgentEntry> = {}): AgentEntry => ({ claudeSessionId: SID, kind: 'interactive', ...over });

describe('6.14 resume-logic (sof)', () => {
  it('tmux nomi: cmdr-<id boshi>, band bo\'lsa 3 hex qo\'shimcha; kontrakt regex\'iga mos', () => {
    expect(tmuxResumeName(SID)).toBe('cmdr-a1b97ff9');
    expect(tmuxResumeName(SID, 'abc')).toBe('cmdr-a1b97ff9-abc');
    expect(tmuxResumeName(SID, 'zz!')).toBe('cmdr-a1b97ff9');
    expect(TMUX_SESSION_NAME_RE.test(tmuxResumeName(SID))).toBe(true);
    expect(TMUX_SESSION_NAME_RE.test(tmuxResumeName(SID, 'f0e'))).toBe(true);
    expect(TMUX_SESSION_NAME_RE.test('cmdr-x; rm')).toBe(false);
  });
  it('shell buyruq qatori: mutlaq yo\'l shart, qo\'shtirnoq/yangi qator rad', () => {
    expect(buildResumeShellCommand('/usr/local/bin/claude', SID)).toBe(`'/usr/local/bin/claude' --resume '${SID}'`);
    expect(() => buildResumeShellCommand('claude', SID)).toThrow();
    expect(() => shellQuote("a'b")).toThrow();
    expect(() => shellQuote('a\nb')).toThrow();
  });
  it('tirik: agents yozuvida pid -> process; supervisor ushlab turgan bg -> supervisor; ps -> ps', () => {
    expect(liveVerdict([e({ pid: 10 })], SID)).toEqual({ live: true, why: 'process' });
    expect(liveVerdict([e({ kind: 'bg', shortId: 'a1b97ff9' })], SID, { holds: () => true })).toEqual({ live: true, why: 'supervisor' });
    expect(liveVerdict([e({ kind: 'bg', shortId: 'a1b97ff9' })], SID, { holds: () => false })).toEqual({ live: false });
    expect(liveVerdict([], SID, { psLines: [`/usr/bin/claude --resume ${SID}`] })).toEqual({ live: true, why: 'ps' });
  });
  it('tugagan (pid yo\'q) va boshqa sessiya tirik: davom ettirish mumkin', () => {
    expect(liveVerdict([e(), e({ claudeSessionId: 'other', pid: 5 })], SID, { psLines: ['/usr/bin/claude --resume other', 'vim notes'] })).toEqual({ live: false });
  });
  it('ps qatori: faqat butun token va claude ijrochisi', () => {
    expect(psLineResumes(`node /x/claude-code/cli.js -r ${SID}`, SID)).toBe(true);
    expect(psLineResumes(`claude --resume=${SID}`, SID)).toBe(true);
    expect(psLineResumes(`claude --session-id ${SID}`, SID)).toBe(true);
    expect(psLineResumes(`claude --resume ${SID}x`, SID)).toBe(false);
    expect(psLineResumes(`grep ${SID}`, SID)).toBe(false);
    expect(psLineResumes(`vim --resume ${SID}`, SID)).toBe(false);
  });
  it('natija: bir xil id = ok, boshqa id = forked, hech narsa = waiting', () => {
    expect(classifyResumed([e({ pid: 1 })], SID).kind).toBe('ok');
    expect(classifyResumed([e({ pid: 1, claudeSessionId: 'new-id' })], SID).kind).toBe('forked');
    expect(classifyResumed([], SID).kind).toBe('waiting');
    expect(classifyResumed([e({ pid: 1, claudeSessionId: 'new-id' }), e({ pid: 2 })], SID).kind).toBe('ok');
  });
  it('yopish rejasi: Escape, literal /exit, Enter; sessiya nomi yorliqdan; muhit tozalanadi', () => {
    expect(planCloseSteps('%4').map((s) => s.args)).toEqual([['send-keys', '-t', '%4', 'Escape'], ['send-keys', '-t', '%4', '-l', '--', '/exit'], ['send-keys', '-t', '%4', 'Enter']]);
    expect(tmuxSessionOfLabel('cmdr-a1b97ff9:0.0')).toBe('cmdr-a1b97ff9');
    expect(scrubTmuxEnv({ PATH: '/bin', AGENTD_TOKEN: 'x', COMMANDER_SECRET: 'y', TMUX: '/t,1,0', TMUX_PANE: '%1', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
