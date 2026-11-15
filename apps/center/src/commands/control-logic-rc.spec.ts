import { describe, expect, it } from 'vitest';
import type { AgentControlState } from '@commander/contracts';
import { needsStepUp, precheckCommand, sessionControl } from './control-logic.js';

const CONTROL: AgentControlState = {
  enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3,
  allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, remoteControl: true,
};
const base = { machineOnline: true, control: CONTROL, machineOs: 'darwin' };

describe('Remote Control: step-up', () => {
  it('yoqish step-up talab qiladi, o\'chirish talab qilmaydi', () => {
    expect(needsStepUp('session.remote_control', undefined, true)).toBe(true);
    expect(needsStepUp('session.remote_control', undefined, false)).toBe(false);
    expect(needsStepUp('session.remote_control')).toBe(false);
  });
});

describe('Remote Control: precheck', () => {
  it('tmux sessiya + yangi agentd + allowPrompt: o\'tadi', () => {
    expect(precheckCommand({ ...base, type: 'session.remote_control', session: { kind: 'tmux', ended: false } })).toBeNull();
  });
  it('bg sessiya: remote_control_unsupported; tmuxsiz terminal: interactive_session', () => {
    expect(precheckCommand({ ...base, type: 'session.remote_control', session: { kind: 'bg', ended: false } })).toMatchObject({ code: 'remote_control_unsupported' });
    expect(precheckCommand({ ...base, type: 'session.remote_control', session: { kind: 'interactive', ended: false } })).toMatchObject({ code: 'interactive_session' });
  });
  it('Windows\'da tmux yo\'q: interactive_session', () => {
    expect(precheckCommand({ ...base, machineOs: 'win32', type: 'session.remote_control', session: { kind: 'tmux', ended: false } })).toMatchObject({ code: 'interactive_session' });
  });
  it('allowPrompt=false yoki eski agentd (remoteControl e\'lon qilinmagan): rad', () => {
    expect(precheckCommand({ ...base, control: { ...CONTROL, allowPrompt: false }, type: 'session.remote_control', session: { kind: 'tmux', ended: false } })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, control: { ...CONTROL, remoteControl: undefined }, type: 'session.remote_control', session: { kind: 'tmux', ended: false } })).toMatchObject({ code: 'agent_outdated' });
  });
  it('tugagan sessiya / offline mashina', () => {
    expect(precheckCommand({ ...base, type: 'session.remote_control', session: { kind: 'tmux', ended: true } })).toMatchObject({ code: 'session_ended' });
    expect(precheckCommand({ ...base, machineOnline: false, type: 'session.remote_control', session: { kind: 'tmux', ended: false } })).toMatchObject({ code: 'machine_offline' });
  });
  it('session.start + remoteControl: allowPrompt va agentd e\'loni shart', () => {
    expect(precheckCommand({ ...base, type: 'session.start', permissionMode: 'plan', remoteControl: true })).toBeNull();
    expect(precheckCommand({ ...base, control: { ...CONTROL, allowPrompt: false }, type: 'session.start', permissionMode: 'plan', remoteControl: true })).toMatchObject({ code: 'action_not_allowed' });
    expect(precheckCommand({ ...base, control: { ...CONTROL, remoteControl: undefined }, type: 'session.start', permissionMode: 'plan', remoteControl: true })).toMatchObject({ code: 'agent_outdated' });
    // RC'siz start eski agentd'da ham o'tadi
    expect(precheckCommand({ ...base, control: { ...CONTROL, remoteControl: undefined }, type: 'session.start', permissionMode: 'plan' })).toBeNull();
  });
});

describe('Remote Control: sessionControl.controls.remoteControl', () => {
  const i = { machineOnline: true, control: CONTROL, ended: false, machineOs: 'darwin' };
  it('faqat tmux sessiyada va siyosat ruxsat bergandagina true', () => {
    expect(sessionControl({ ...i, sessionKind: 'tmux' }).controls.remoteControl).toBe(true);
    expect(sessionControl({ ...i, sessionKind: 'bg' }).controls.remoteControl).toBeFalsy();
    expect(sessionControl({ ...i, sessionKind: 'interactive' }).controls.remoteControl).toBeFalsy();
    expect(sessionControl({ ...i, sessionKind: 'tmux', control: { ...CONTROL, allowPrompt: false } }).controls.remoteControl).toBeFalsy();
    expect(sessionControl({ ...i, sessionKind: 'tmux', control: { ...CONTROL, remoteControl: undefined } }).controls.remoteControl).toBeFalsy();
    expect(sessionControl({ ...i, sessionKind: 'tmux', ended: true }).controls.remoteControl).toBeFalsy();
  });
});
