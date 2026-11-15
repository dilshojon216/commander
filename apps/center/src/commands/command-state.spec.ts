import { COMMAND_STATES, isTerminalCommandState } from '@commander/contracts';
import { describe, expect, it } from 'vitest';
import { applyAgentAck, applyAgentResult, canTransition } from './command-state.js';

describe('buyruq holat mashinasi', () => {
  it('yakuniy holatlardan hech qayerga o\'tib bo\'lmaydi', () => {
    for (const from of COMMAND_STATES.filter(isTerminalCommandState)) for (const to of COMMAND_STATES) expect(canTransition(from, to)).toBe(false);
  });
  it('asosiy yo\'l: awaiting -> pending -> sent -> acked -> running -> done', () => {
    const path = ['awaiting_confirmation', 'pending', 'sent', 'acked', 'running', 'done'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('sakrab o\'tish yo\'q: awaiting -> sent, pending -> acked, awaiting -> done', () => {
    expect(canTransition('awaiting_confirmation', 'sent')).toBe(false);
    expect(canTransition('pending', 'acked')).toBe(false);
    expect(canTransition('awaiting_confirmation', 'done')).toBe(false);
  });
  it('ack: faqat sent -> acked', () => {
    expect(applyAgentAck('sent')).toEqual({ kind: 'apply', to: 'acked' });
    for (const s of COMMAND_STATES.filter((x) => x !== 'sent')) expect(applyAgentAck(s)).toEqual({ kind: 'noop' });
  });
  it('natija: ack yo\'qolgan holat (sent -> done) qabul qilinadi', () => {
    expect(applyAgentResult('sent', { state: 'done' })).toEqual({ kind: 'apply', to: 'done' });
    expect(applyAgentResult('acked', { state: 'running' })).toEqual({ kind: 'apply', to: 'running' });
    expect(applyAgentResult('running', { state: 'failed' })).toEqual({ kind: 'apply', to: 'failed' });
  });
  it('running holatdagi rejected = failed (bajarish allaqachon boshlangan)', () => {
    expect(applyAgentResult('running', { state: 'rejected' })).toEqual({ kind: 'apply', to: 'failed' });
    expect(applyAgentResult('sent', { state: 'rejected' })).toEqual({ kind: 'apply', to: 'rejected' });
  });
  it('dispatch qilinmagan buyruq haqida natija: e\'tiborsiz; yakuniy holat o\'zgarmaydi; takror no-op', () => {
    expect(applyAgentResult('awaiting_confirmation', { state: 'done' })).toEqual({ kind: 'noop' });
    expect(applyAgentResult('pending', { state: 'done' })).toEqual({ kind: 'noop' });
    expect(applyAgentResult('expired', { state: 'done' })).toEqual({ kind: 'noop' });
    expect(applyAgentResult('done', { state: 'failed' })).toEqual({ kind: 'noop' });
    expect(applyAgentResult('running', { state: 'running' })).toEqual({ kind: 'noop' });
  });
});
