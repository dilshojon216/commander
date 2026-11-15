import { describe, expect, it } from 'vitest';
import type { AgentControlState } from '@commander/contracts';
import { needsStepUp, precheckCommand, sessionControl } from './control-logic.js';

const ctl = (over: Partial<AgentControlState> = {}): AgentControlState => ({
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false,
  maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, ...over,
});
const base = { machineOnline: true, control: ctl(), sessionKind: 'bg', ended: false, machineOs: 'darwin' };

describe('sessionControl (UI prompt-box holati)', () => {
  it('bg + yoqilgan siyosat: controllable', () => {
    expect(sessionControl(base)).toEqual({ controllable: true, controlReason: null, controls: { prompt: true, stop: true, setMode: false } });
  });
  it('sabablar ustuvorligi: ended > offline > agent holati > interactive', () => {
    expect(sessionControl({ ...base, ended: true, machineOnline: false }).controlReason).toBe('session_ended');
    expect(sessionControl({ ...base, machineOnline: false }).controlReason).toBe('machine_offline');
    expect(sessionControl({ ...base, control: null }).controlReason).toBe('agent_outdated');
    expect(sessionControl({ ...base, control: ctl({ enabled: false }) }).controlReason).toBe('policy_disabled');
    expect(sessionControl({ ...base, control: ctl({ centerKeyPinned: false }) }).controlReason).toBe('agent_not_ready');
    expect(sessionControl({ ...base, control: ctl({ runningAsRoot: true }) }).controlReason).toBe('agent_not_ready');
    expect(sessionControl({ ...base, control: ctl({ allowPrompt: false }) })).toMatchObject({ controllable: false, controlReason: 'prompt_not_allowed' });
  });
  it('terminal sessiya: "faqat ko\'rish" (interactive), stop = interrupt faqat POSIX', () => {
    expect(sessionControl({ ...base, sessionKind: 'interactive' })).toEqual({ controllable: false, controlReason: 'interactive', controls: { prompt: false, stop: true, setMode: false } });
    expect(sessionControl({ ...base, sessionKind: 'interactive', machineOs: 'win32' }).controls.stop).toBe(false);
  });
  it('tmux sessiya (2.6): prompt + stop, set_mode yo\'q; siyosat prompt\'ni yopsa prompt_not_allowed; Windows\'da ko\'rish', () => {
    expect(sessionControl({ ...base, sessionKind: 'tmux' })).toEqual({ controllable: true, controlReason: null, controls: { prompt: true, stop: true, setMode: false } });
    expect(sessionControl({ ...base, sessionKind: 'tmux', control: ctl({ allowPrompt: false }) })).toEqual({ controllable: false, controlReason: 'prompt_not_allowed', controls: { prompt: false, stop: true, setMode: false } });
    expect(sessionControl({ ...base, sessionKind: 'tmux', control: ctl({ allowStop: false }) }).controls).toEqual({ prompt: true, stop: false, setMode: false });
    expect(sessionControl({ ...base, sessionKind: 'tmux', machineOs: 'win32' }).controlReason).toBe('interactive');
    expect(sessionControl({ ...base, sessionKind: 'tmux', ended: true }).controlReason).toBe('session_ended');
    expect(sessionControl({ ...base, sessionKind: 'tmux', control: ctl({ enabled: false }) }).controlReason).toBe('policy_disabled');
  });
});

describe('precheckCommand', () => {
  const ok = { machineOnline: true, control: ctl(), machineOs: 'darwin', session: { kind: 'bg', ended: false } };
  it('offline / policy / action / auto', () => {
    expect(precheckCommand({ ...ok, type: 'session.stop', machineOnline: false })).toMatchObject({ code: 'machine_offline' });
    expect(precheckCommand({ ...ok, type: 'session.stop', control: null })).toMatchObject({ code: 'agent_outdated' });
    expect(precheckCommand({ ...ok, type: 'session.stop', control: ctl({ enabled: false }) })).toMatchObject({ code: 'policy_disabled' });
    expect(precheckCommand({ ...ok, type: 'session.prompt', control: ctl({ allowPrompt: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ type: 'session.start', permissionMode: 'auto', machineOnline: true, control: ctl(), machineOs: 'darwin' })).toMatchObject({ code: 'mode_not_allowed' });
    expect(precheckCommand({ type: 'session.start', permissionMode: 'plan', machineOnline: true, control: ctl(), machineOs: 'darwin' })).toBeNull();
  });
  it('tmux sessiya: prompt va stop o\'tadi, set_mode = set_mode_unsupported, prompt siyosat bilan', () => {
    const tmux = { kind: 'tmux', ended: false };
    expect(precheckCommand({ ...ok, type: 'session.prompt', session: tmux })).toBeNull();
    expect(precheckCommand({ ...ok, type: 'session.stop', session: tmux })).toBeNull();
    expect(precheckCommand({ ...ok, type: 'session.set_mode', permissionMode: 'plan', session: tmux })).toMatchObject({ code: 'set_mode_unsupported' });
    expect(precheckCommand({ ...ok, type: 'session.prompt', session: tmux, control: ctl({ allowPrompt: false }) })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...ok, type: 'session.prompt', session: tmux, machineOs: 'win32' })).toMatchObject({ code: 'interactive_session' });
  });
  it('terminal sessiya: prompt/set_mode rad, stop o\'tadi (Windows\'da yo\'q); bg set_mode = unsupported; tugagan sessiya', () => {
    const term = { kind: 'interactive', ended: false };
    expect(precheckCommand({ ...ok, type: 'session.prompt', session: term })).toMatchObject({ code: 'interactive_session' });
    expect(precheckCommand({ ...ok, type: 'session.stop', session: term })).toBeNull();
    expect(precheckCommand({ ...ok, type: 'session.stop', session: term, machineOs: 'win32' })).toMatchObject({ code: 'interactive_session' });
    expect(precheckCommand({ ...ok, type: 'session.set_mode', permissionMode: 'plan' })).toMatchObject({ code: 'set_mode_unsupported' });
    expect(precheckCommand({ ...ok, type: 'session.prompt', session: { kind: 'bg', ended: true } })).toMatchObject({ code: 'session_ended' });
  });
});

describe('needsStepUp', () => {
  it('start har doim; set_mode faqat acceptEdits/auto; prompt va stop hech qachon', () => {
    expect(needsStepUp('session.start', 'plan')).toBe(true);
    expect(needsStepUp('session.start', 'default')).toBe(true);
    expect(needsStepUp('session.set_mode', 'acceptEdits')).toBe(true);
    expect(needsStepUp('session.set_mode', 'auto')).toBe(true);
    expect(needsStepUp('session.set_mode', 'plan')).toBe(false);
    expect(needsStepUp('session.set_mode', 'default')).toBe(false);
    expect(needsStepUp('session.prompt')).toBe(false);
    expect(needsStepUp('session.stop')).toBe(false);
  });
});


describe('precheckCommand: loyiha buyruqlari (2.15)', () => {
  const ctl = (over: Partial<AgentControlState> = {}): AgentControlState => ({
    enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3,
    allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, projectOps: true, allowProjectRead: true, allowProjectWrite: true, ...over,
  });
  const base = { machineOnline: true, machineOs: 'linux' };

  it('hammasi tayyor bo\'lsa o\'tadi', () => {
    for (const type of ['project.refresh', 'project.read_md', 'project.append_tasks', 'project.summarize'] as const) {
      expect(precheckCommand({ ...base, type, control: ctl() })).toBeNull();
    }
  });
  it('eski agentd (projectOps yo\'q) = agent_outdated; offline = machine_offline; siyosat o\'chiq = policy_disabled', () => {
    expect(precheckCommand({ ...base, type: 'project.refresh', control: ctl({ projectOps: undefined as unknown as boolean }) })?.code).toBe('agent_outdated');
    expect(precheckCommand({ ...base, type: 'project.refresh', control: ctl(), machineOnline: false })?.code).toBe('machine_offline');
    expect(precheckCommand({ ...base, type: 'project.refresh', control: ctl({ enabled: false }) })?.code).toBe('policy_disabled');
  });
  it('yozish va o\'qish alohida ruxsat: allowProjectWrite=false faqat append\'ni rad etadi', () => {
    const c = ctl({ allowProjectWrite: false });
    expect(precheckCommand({ ...base, type: 'project.append_tasks', control: c })?.code).toBe('action_not_allowed');
    expect(precheckCommand({ ...base, type: 'project.read_md', control: c })).toBeNull();
    expect(precheckCommand({ ...base, type: 'project.summarize', control: ctl({ allowProjectRead: false }) })?.code).toBe('action_not_allowed');
  });
  it('step-up: faqat append_tasks (haiku xulosa, o\'qish va yangilash step-up\'siz)', () => {
    expect(needsStepUp('project.append_tasks')).toBe(true);
    for (const t of ['project.refresh', 'project.read_md', 'project.summarize'] as const) expect(needsStepUp(t)).toBe(false);
  });
});
