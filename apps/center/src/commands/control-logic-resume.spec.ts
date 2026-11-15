import { describe, expect, it } from 'vitest';
import type { AgentControlState } from '@commander/contracts';
import { needsStepUp, precheckCommand, sessionControl, sessionResume } from './control-logic.js';

const ctl = (over: Partial<AgentControlState> = {}): AgentControlState => ({
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1,
  centerKeyPinned: true, runningAsRoot: false, resume: true, close: true, ...over,
});
const inp = (over: Partial<Parameters<typeof sessionResume>[0]> = {}) => ({ machineOnline: true, control: ctl(), sessionKind: 'interactive', ended: true, machineOs: 'darwin', cwd: '/w/proj', ...over });

describe('6.14 sessionResume / precheck', () => {
  it('tugagan terminal sessiya + ruxsat: available', () => {
    expect(sessionResume(inp())).toEqual({ available: true, reason: null });
    expect(sessionResume(inp({ sessionKind: 'tmux' })).available).toBe(true);
  });
  it('sabablar: tirik, bg, Windows, offline, siyosat, eski agentd, allowStart, cwd', () => {
    expect(sessionResume(inp({ ended: false })).reason).toBe('not_ended');
    expect(sessionResume(inp({ sessionKind: 'bg' })).reason).toBe('not_terminal');
    expect(sessionResume(inp({ machineOs: 'win32' })).reason).toBe('unsupported_os');
    expect(sessionResume(inp({ machineOnline: false })).reason).toBe('machine_offline');
    expect(sessionResume(inp({ control: ctl({ enabled: false }) })).reason).toBe('policy_disabled');
    expect(sessionResume(inp({ control: ctl({ centerKeyPinned: false }) })).reason).toBe('agent_not_ready');
    expect(sessionResume(inp({ control: null })).reason).toBe('agent_outdated');
    expect(sessionResume(inp({ control: ctl({ resume: undefined }) })).reason).toBe('agent_outdated');
    expect(sessionResume(inp({ control: ctl({ allowStart: false }) })).reason).toBe('start_not_allowed');
    expect(sessionResume(inp({ cwd: null })).reason).toBe('no_cwd');
  });
  it('precheck: kodlar (o\'zbekcha matn tirik sessiya uchun)', () => {
    const pre = (over: Partial<Parameters<typeof precheckCommand>[0]> = {}) =>
      precheckCommand({ type: 'session.resume', machineOnline: true, control: ctl(), machineOs: 'darwin', session: { kind: 'interactive', ended: true, cwd: '/w' }, ...over });
    expect(pre()).toBeNull();
    expect(pre({ session: { kind: 'interactive', ended: false, cwd: '/w' } })).toEqual({ code: 'session_still_running', message: 'Sessiya hali terminalda ochiq — avval undan chiqing' });
    expect(pre({ machineOs: 'win32' })?.code).toBe('resume_unsupported');
    expect(pre({ control: ctl({ resume: undefined }) })?.code).toBe('agent_outdated');
    expect(pre({ control: ctl({ allowStart: false }) })?.code).toBe('action_not_allowed');
    expect(pre({ machineOnline: false })?.code).toBe('machine_offline');
  });
  it('step-up: resume har doim; close yo\'q', () => {
    expect(needsStepUp('session.resume')).toBe(true);
    expect(needsStepUp('session.close')).toBe(false);
  });
  it('flip: resume dan keyin kind=tmux -> controllable (prompt/stop/close)', () => {
    const v = sessionControl({ machineOnline: true, control: ctl(), sessionKind: 'tmux', ended: false, machineOs: 'darwin' });
    expect(v).toMatchObject({ controllable: true, controls: { prompt: true, stop: true, close: true } });
    expect(sessionControl({ machineOnline: true, control: ctl(), sessionKind: 'interactive', ended: false, machineOs: 'darwin' }).controllable).toBe(false);
  });
  it('close precheck: faqat tmux, allowStop va agentd e\'loni', () => {
    const pre = (over: Partial<Parameters<typeof precheckCommand>[0]> = {}) =>
      precheckCommand({ type: 'session.close', machineOnline: true, control: ctl(), machineOs: 'darwin', session: { kind: 'tmux', ended: false }, ...over });
    expect(pre()).toBeNull();
    expect(pre({ session: { kind: 'interactive', ended: false } })?.code).toBe('interactive_session');
    expect(pre({ session: { kind: 'bg', ended: false } })?.code).toBe('interactive_session');
    expect(pre({ control: ctl({ allowStop: false }) })?.code).toBe('action_not_allowed');
    expect(pre({ control: ctl({ close: undefined }) })?.code).toBe('agent_outdated');
    expect(pre({ session: { kind: 'tmux', ended: true } })?.code).toBe('session_ended');
  });
});
