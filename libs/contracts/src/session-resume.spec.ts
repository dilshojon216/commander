import { describe, expect, it } from 'vitest';
import { AgentControlStateSchema, COMMAND_ERROR_CODES, COMMAND_TYPES, CommandDispatchPayloadSchema, CommandResultDataSchema, CreateCommandBodySchema, SessionControlsSchema, SessionResumeSchema } from './index.js';

const SID = '7e57c0de-1111-4222-8333-444455556666';
const base = { commandId: SID, nonce: 'a'.repeat(43), expiresAt: Date.now() + 1000, sig: 'b'.repeat(86) };

describe('6.14 session.resume / session.close kontrakti', () => {
  it('turlar va xato kodlari', () => {
    expect(COMMAND_TYPES).toContain('session.resume');
    expect(COMMAND_TYPES).toContain('session.close');
    for (const c of ['session_still_running', 'resume_unsupported', 'resume_forked', 'close_failed', 'agent_outdated']) expect(COMMAND_ERROR_CODES).toContain(c);
  });
  it('REST: faqat sessionId (strict): cwd/claudeSessionId mijozdan QABUL QILINMAYDI', () => {
    for (const type of ['session.resume', 'session.close']) {
      expect(CreateCommandBodySchema.safeParse({ type, sessionId: SID }).success).toBe(true);
      expect(CreateCommandBodySchema.safeParse({ type, sessionId: SID, cwd: '/etc' }).success).toBe(false);
      expect(CreateCommandBodySchema.safeParse({ type, sessionId: 'x' }).success).toBe(false);
    }
  });
  it('dispatch payload: resume = claudeSessionId + cwd, close = claudeSessionId', () => {
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'session.resume', payload: { claudeSessionId: 'abc-1', cwd: '/w' } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'session.resume', payload: { claudeSessionId: 'abc-1' } }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'session.resume', payload: { claudeSessionId: 'a b', cwd: '/w' } }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, type: 'session.close', payload: { claudeSessionId: 'abc-1' } }).success).toBe(true);
  });
  it('natija: tmuxSession faqat xavfsiz nom', () => {
    expect(CommandResultDataSchema.safeParse({ tmuxSession: 'cmdr-a1b97ff9' }).success).toBe(true);
    expect(CommandResultDataSchema.safeParse({ tmuxSession: 'cmdr-a1b97ff9-0af' }).success).toBe(true);
    for (const bad of ['x', 'cmdr-a; rm -rf /', 'cmdr-$(id)', 'other-a1b97ff9']) expect(CommandResultDataSchema.safeParse({ tmuxSession: bad }).success).toBe(false);
  });
  it('ixtiyoriy maydonlar (eski klientlar): resume/close', () => {
    expect(SessionResumeSchema.safeParse({ available: false, reason: 'not_ended' }).success).toBe(true);
    expect(SessionResumeSchema.safeParse({ available: false, reason: 'nope' }).success).toBe(false);
    expect(SessionControlsSchema.safeParse({ prompt: true, stop: true, setMode: false, close: true }).success).toBe(true);
    expect(AgentControlStateSchema.safeParse({ enabled: true, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: false, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 1, centerKeyPinned: true, runningAsRoot: false, resume: true, close: true }).success).toBe(true);
  });
});
