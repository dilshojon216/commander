import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_BY_PUSH_TYPE,
  CLIENT_CHANNELS,
  CLIENT_WS_SUBPROTOCOL,
  ClientToServerMessageSchema,
  LockdownUpdatedMessageSchema,
  ServerToClientMessageSchema,
  UsageTickMessageSchema,
  buildClientSubprotocols,
  createEnvelope,
} from './index.js';

describe('client -> server messages', () => {
  it('auth, subscribe, unsubscribe, ping are accepted', () => {
    for (const env of [
      createEnvelope('auth', { token: 'cmdr_x' }),
      createEnvelope('subscribe', { channels: ['sessions', 'usage'] }),
      createEnvelope('unsubscribe', { channels: ['usage'] }),
      createEnvelope('ping', {}),
    ]) {
      expect(ClientToServerMessageSchema.safeParse(env).success).toBe(true);
    }
  });

  it('unknown channels and empty/oversized channel lists are rejected', () => {
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('subscribe', { channels: ['commands'] })).success).toBe(true);
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('subscribe', { channels: ['bogus'] })).success).toBe(false);
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('subscribe', { channels: [] })).success).toBe(false);
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('subscribe', { channels: [...CLIENT_CHANNELS, 'sessions'] })).success).toBe(false);
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('decision', { behavior: 'allow' })).success).toBe(false); // qaror WS orqali emas
  });
});

describe('server -> client messages', () => {
  it('usage.tick carries aggregated deltas by machine and by project (null project allowed)', () => {
    const b = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, requests: 1 };
    const env = createEnvelope('usage.tick', { from: 1, to: 2, total: b, byMachine: [{ machineId: randomUUID(), ...b }], byProject: [{ projectId: null, ...b }] });
    expect(UsageTickMessageSchema.safeParse(env).success).toBe(true);
    expect(ServerToClientMessageSchema.safeParse(env).success).toBe(true);
  });

  it('lockdown.updated and auth.ok shapes', () => {
    expect(LockdownUpdatedMessageSchema.safeParse(createEnvelope('lockdown.updated', { enabled: true, since: '2026-11-13T10:00:00.000Z' })).success).toBe(true);
    const ok = createEnvelope('auth.ok', { deviceId: randomUUID(), kind: 'web', scopes: ['read'], serverTime: Date.now(), channels: [...CLIENT_CHANNELS], lockdown: { enabled: false, since: null } });
    expect(ServerToClientMessageSchema.safeParse(ok).success).toBe(true);
  });

  it('every push type maps to a subscribable channel', () => {
    for (const channel of Object.values(CHANNEL_BY_PUSH_TYPE)) expect(CLIENT_CHANNELS).toContain(channel);
    expect(Object.keys(CHANNEL_BY_PUSH_TYPE).sort()).toEqual(['alert.created', 'alert.updated', 'approval.created', 'approval.resolved', 'command.updated', 'limits.updated', 'machine.health', 'machine.updated', 'message.created', 'message.updated', 'orchestration.updated', 'project.updated', 'queue.updated', 'session.updated', 'usage.tick']);
  });

  it('subprotocol helper offers commander.v1 first so the token is never echoed back', () => {
    const [first, second] = buildClientSubprotocols('cmdr_abc');
    expect(first).toBe(CLIENT_WS_SUBPROTOCOL);
    expect(second).toBe('cmdr-token.cmdr_abc');
  });
});
