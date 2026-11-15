import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEnvelope } from './envelope.js';
import { AgentToCenterMessageSchema, CenterToAgentMessageSchema } from './agent-protocol.js';
import {
  CommandDispatchPayloadSchema,
  CommandResultPayloadSchema,
  CreateCommandBodySchema,
  REMOTE_PERMISSION_MODES,
  buildCommandSigString,
  canonicalJson,
} from './commands.js';

const NONCE = 'n'.repeat(43);
const SIG = 's'.repeat(86);

describe('create command body', () => {
  const machineId = randomUUID();
  const ok = { type: 'session.start', machineId, cwd: '/w/p', prompt: 'hi', permissionMode: 'plan' };
  it('qabul qilinadigan shakllar', () => {
    expect(CreateCommandBodySchema.safeParse(ok).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.prompt', sessionId: randomUUID(), text: 'x' }).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.stop', sessionId: randomUUID() }).success).toBe(true);
    expect(CreateCommandBodySchema.safeParse({ type: 'session.set_mode', sessionId: randomUUID(), permissionMode: 'acceptEdits' }).success).toBe(true);
  });
  it('bypassPermissions / dontAsk / noma\'lum rejim va qo\'shimcha kalitlar rad etiladi', () => {
    expect(REMOTE_PERMISSION_MODES).not.toContain('bypassPermissions');
    for (const permissionMode of ['bypassPermissions', 'dontAsk', 'manual', '']) expect(CreateCommandBodySchema.safeParse({ ...ok, permissionMode }).success).toBe(false);
    expect(CreateCommandBodySchema.safeParse({ ...ok, dangerouslySkipPermissions: true }).success).toBe(false);
    expect(CreateCommandBodySchema.safeParse({ ...ok, model: 'a b' }).success).toBe(false);
    expect(CreateCommandBodySchema.safeParse({ ...ok, prompt: 'x'.repeat(16_001) }).success).toBe(false);
  });
});

describe('dispatch / ack / result sxemalari', () => {
  const dispatch = { commandId: randomUUID(), type: 'session.stop', payload: { claudeSessionId: 'abc' }, nonce: NONCE, expiresAt: Date.now() + 60_000, sig: SIG };
  it('dispatch: payload type bo\'yicha tekshiriladi; markaz->agent va agent->markaz unionlari', () => {
    expect(CommandDispatchPayloadSchema.safeParse(dispatch).success).toBe(true);
    expect(CommandDispatchPayloadSchema.safeParse({ ...dispatch, payload: { claudeSessionId: '../x' } }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ ...dispatch, type: 'session.start' }).success).toBe(false);
    expect(CommandDispatchPayloadSchema.safeParse({ ...dispatch, sig: 'short' }).success).toBe(false);
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('command.dispatch', dispatch)).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('command.ack', { commandId: dispatch.commandId })).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('command.result', { commandId: dispatch.commandId, state: 'done', result: { claudeSessionId: 's' } })).success).toBe(true);
    expect(CommandResultPayloadSchema.safeParse({ commandId: dispatch.commandId, state: 'queued' }).success).toBe(false);
  });
  it('heartbeat control va auth.ok centerPublicKey ixtiyoriy, lekin tekshiriladi', () => {
    const control = { enabled: false, allowStart: true, allowPrompt: true, allowStop: true, allowSetMode: true, allowAutoMode: false, maxConcurrentStarted: 3, allowedRootCount: 0, centerKeyPinned: false, runningAsRoot: false };
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('agent.heartbeat', { control })).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('agent.heartbeat', { control: { enabled: true } })).success).toBe(false);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('agent.heartbeat', {})).success).toBe(true);
  });
});

describe('imzo satri', () => {
  const parts = { deviceId: 'ABCDEF', commandId: 'C1', type: 'session.stop' as const, nonce: NONCE, expiresAt: 5, payloadSha256: 'AB'.repeat(32) };
  it('qat\'iy format, kichik harf, oxirida \\n yo\'q', () => {
    expect(buildCommandSigString(parts)).toBe(['COMMANDER-CMD-V1', 'abcdef', 'c1', 'session.stop', NONCE, '5', 'ab'.repeat(32)].join('\n'));
  });
  it('canonicalJson: kalit tartibi, ichma-ich, undefined tashlanadi, unicode/escape', () => {
    expect(canonicalJson({ b: [1, { z: 1, a: 'é"\n' }], a: undefined, c: null })).toBe('{"b":[1,{"a":"é\\"\\n","z":1}],"c":null}');
  });
});
