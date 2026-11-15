import { describe, expect, it } from 'vitest';
import { CommandDispatchPayloadSchema, CreateCommandBodySchema, RC_URL_RE, RemoteControlResultSchema, RemoteControlStateSchema, SessionControlsSchema, StartPayloadSchema, CommandResultDataSchema } from './index.js';

const SID = '7e57c0de-1111-4222-8333-444455556666';

describe('Remote Control kontrakti (3.10)', () => {
  it('REST: session.remote_control {sessionId, enable, name?} (strict)', () => {
    expect(CreateCommandBodySchema.safeParse({ type: 'session.remote_control', sessionId: SID, enable: true }).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.remote_control', sessionId: SID, enable: false, name: 'my rc' }).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.remote_control', sessionId: SID }).success).toBe(false);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.remote_control', sessionId: SID, enable: true, name: 'x; rm -rf /' }).success).toBe(false);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.remote_control', sessionId: SID, enable: true, extra: 1 }).success).toBe(false);
  });
  it('session.start: remoteControl ixtiyoriy boolean', () => {
    const base = { type: 'session.start', machineId: SID, cwd: '/w', prompt: 'hi', permissionMode: 'plan' };
    expect(CreateCommandBodySchema.safeParse({ ...base, remoteControl: true }).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ ...base, remoteControl: 'yes' }).success).toBe(false);
    expect(StartPayloadSchema.safeParse({ cwd: '/w', prompt: 'hi', permissionMode: 'plan', remoteControl: true }).success).toBe(true);
  });
  it('dispatch: session.remote_control payload claudeSessionId + enable', () => {
    const base = { commandId: SID, nonce: 'a'.repeat(43), expiresAt: Date.now() + 1000, sig: 'b'.repeat(86), type: 'session.remote_control' };
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, payload: { claudeSessionId: 'abc-123', enable: true, name: 'n1' } }).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...base, payload: { claudeSessionId: 'abc-123' } }).success).toBe(false);
  });
  it('natija: faqat claude.ai/code havolasi qabul qilinadi', () => {
    const url = 'https://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y';
    expect(RC_URL_RE.test(url)).toBe(true);
    for (const bad of ['http://claude.ai/code/session_01Lb25s1rUPNVGEwNscyZi6y', 'https://evil.example/code/session_01Lb25s1rUPNVGEwNscyZi6y', `${url}?x=1`, 'https://claude.ai/code/session_x']) {
      expect(RC_URL_RE.test(bad)).toBe(false);
      expect(RemoteControlResultSchema.safeParse({ enabled: true, url: bad }).success).toBe(false);
    }
    expect(CommandResultDataSchema.safeParse({ remoteControl: { enabled: true, name: 'my rc', url } }).success).toBe(true);
    expect(CommandResultDataSchema.safeParse({ remoteControl: { enabled: false } }).success).toBe(true);
    expect(RemoteControlStateSchema.safeParse({ enabled: true, name: null, since: new Date().toISOString() }).success).toBe(true);
  });
  it('controls.remoteControl ixtiyoriy (eski klientlar)', () => {
    expect(SessionControlsSchema.safeParse({ prompt: true, stop: true, setMode: false }).success).toBe(true);
    expect(SessionControlsSchema.safeParse({ prompt: true, stop: true, setMode: false, remoteControl: true }).success).toBe(true);
  });
});
