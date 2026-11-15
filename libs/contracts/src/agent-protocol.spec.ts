import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTH_STRING_VERSION,
  AGENT_LIMITS,
  AckMessageSchema,
  AgentEventSchema,
  AgentEventsMessageSchema,
  AgentHeartbeatMessageSchema,
  AgentLimitsMessageSchema,
  AgentToCenterMessageSchema,
  AgentUsageMessageSchema,
  AuthChallengeMessageSchema,
  AuthResponseMessageSchema,
  EnvelopeSchema,
  NackMessageSchema,
  buildAgentAuthString,
  createEnvelope,
} from './index.js';

const NONCE = 'A'.repeat(43);
const SIG = 'B'.repeat(86);
const DEVICE = randomUUID();
const now = 1_767_261_600_000;

const event = (over: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  claudeSessionId: 's-1',
  event: 'PreToolUse',
  status: 'working',
  cwd: '/work/commander',
  ts: now,
  ...over,
});

const usage = (over: Record<string, unknown> = {}) => ({
  requestId: 'req_1',
  claudeSessionId: 's-1',
  model: 'claude-opus-4',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheCreationTokens: 40,
  source: 'otel',
  ts: now,
  ...over,
});

describe('buildAgentAuthString', () => {
  it('has the exact 4-line canonical shape with a version prefix and no trailing newline', () => {
    const s = buildAgentAuthString({ nonce: NONCE, ts: now, deviceId: DEVICE.toUpperCase() });
    expect(s).toBe([AGENT_AUTH_STRING_VERSION, NONCE, String(now), DEVICE].join('\n'));
    expect(s.startsWith('COMMANDER-AGENT-AUTH-V1\n')).toBe(true);
    expect(s.endsWith('\n')).toBe(false);
  });

  it('changes with every input (nonce, ts, deviceId)', () => {
    const base = buildAgentAuthString({ nonce: NONCE, ts: now, deviceId: DEVICE });
    expect(buildAgentAuthString({ nonce: 'C'.repeat(43), ts: now, deviceId: DEVICE })).not.toBe(base);
    expect(buildAgentAuthString({ nonce: NONCE, ts: now + 1, deviceId: DEVICE })).not.toBe(base);
    expect(buildAgentAuthString({ nonce: NONCE, ts: now, deviceId: randomUUID() })).not.toBe(base);
  });

  it('an Ed25519 signature over it verifies, and fails for another nonce', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const str = buildAgentAuthString({ nonce: NONCE, ts: now, deviceId: DEVICE });
    const sig = sign(null, Buffer.from(str, 'utf8'), privateKey);
    expect(sig.toString('base64url')).toHaveLength(86);
    expect(verify(null, Buffer.from(str, 'utf8'), publicKey, sig)).toBe(true);
    const other = buildAgentAuthString({ nonce: 'D'.repeat(43), ts: now, deviceId: DEVICE });
    expect(verify(null, Buffer.from(other, 'utf8'), publicKey, sig)).toBe(false);
  });
});

describe('envelope', () => {
  it('createEnvelope builds a valid v1 envelope', () => {
    const env = createEnvelope('agent.heartbeat', {}, now);
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env).toMatchObject({ v: 1, type: 'agent.heartbeat', ts: now, payload: {} });
  });

  it('rejects wrong version, non-uuid id and out-of-range ts', () => {
    const ok = createEnvelope('x', {}, now);
    expect(EnvelopeSchema.safeParse({ ...ok, v: 2 }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...ok, id: 'nope' }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...ok, ts: 1.5 }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...ok, ts: 9e15 }).success).toBe(false);
  });
});

describe('auth messages', () => {
  it('parses challenge and response; rejects short nonce / signature', () => {
    expect(
      AuthChallengeMessageSchema.safeParse(createEnvelope('auth.challenge', { nonce: NONCE, serverTime: now, expiresInMs: 10_000 }, now)).success,
    ).toBe(true);
    expect(
      AuthChallengeMessageSchema.safeParse(createEnvelope('auth.challenge', { nonce: 'short', serverTime: now, expiresInMs: 10_000 }, now)).success,
    ).toBe(false);

    const resp = { deviceId: DEVICE, ts: now, signature: SIG, agentdVersion: '0.1.0', hostname: 'mac', os: 'darwin' };
    expect(AuthResponseMessageSchema.safeParse(createEnvelope('auth.response', resp, now)).success).toBe(true);
    expect(AuthResponseMessageSchema.safeParse(createEnvelope('auth.response', { ...resp, claudeVersion: '2.1.304' }, now)).success).toBe(true);
    expect(AuthResponseMessageSchema.safeParse(createEnvelope('auth.response', { ...resp, signature: 'x' }, now)).success).toBe(false);
    expect(AuthResponseMessageSchema.safeParse(createEnvelope('auth.response', { ...resp, deviceId: 'nope' }, now)).success).toBe(false);
  });
});

describe('agent.events', () => {
  it('accepts awaiting_approval and the optional fields', () => {
    const e = event({ status: 'awaiting_approval', message: null, notificationType: 'permission_prompt', transcriptPath: '/t.jsonl', reason: null });
    expect(AgentEventSchema.safeParse(e).success).toBe(true);
    expect(AgentEventsMessageSchema.safeParse(createEnvelope('agent.events', { events: [e] }, now)).success).toBe(true);
  });

  it('rejects unknown status, empty batch, oversize batch, oversize message', () => {
    expect(AgentEventSchema.safeParse(event({ status: 'stale' })).success).toBe(false);
    expect(AgentEventsMessageSchema.safeParse(createEnvelope('agent.events', { events: [] }, now)).success).toBe(false);
    const many = Array.from({ length: AGENT_LIMITS.maxEventsPerBatch + 1 }, () => event());
    expect(AgentEventsMessageSchema.safeParse(createEnvelope('agent.events', { events: many }, now)).success).toBe(false);
    expect(AgentEventSchema.safeParse(event({ message: 'x'.repeat(2001) })).success).toBe(false);
    expect(AgentEventSchema.safeParse(event({ eventId: 'not-a-uuid' })).success).toBe(false);
  });
});

describe('agent.usage', () => {
  it('accepts a record with and without cwd/costUsd', () => {
    const ok = (r: Record<string, unknown>) =>
      AgentUsageMessageSchema.safeParse(createEnvelope('agent.usage', { records: [r] }, now)).success;
    expect(ok(usage())).toBe(true);
    expect(ok(usage({ cwd: '/work/x', costUsd: 0.0123, source: 'transcript', promptId: 'p1' }))).toBe(true);
  });

  it('rejects negative/fractional tokens, bad source, missing ts', () => {
    const bad = (r: Record<string, unknown>) =>
      AgentUsageMessageSchema.safeParse(createEnvelope('agent.usage', { records: [r] }, now)).success;
    expect(bad(usage({ inputTokens: -1 }))).toBe(false);
    expect(bad(usage({ outputTokens: 1.5 }))).toBe(false);
    expect(bad(usage({ source: 'hook' }))).toBe(false);
    const { ts: _ts, ...noTs } = usage();
    expect(bad(noTs)).toBe(false);
  });

  it('caps batch size', () => {
    const many = Array.from({ length: AGENT_LIMITS.maxUsageRecordsPerBatch + 1 }, (_, i) => usage({ requestId: `r${i}` }));
    expect(AgentUsageMessageSchema.safeParse(createEnvelope('agent.usage', { records: many }, now)).success).toBe(false);
  });
});

describe('agent.limits', () => {
  const win = { usedPct: 42.5, resetsAt: now + 3_600_000 };
  const ok = (p: Record<string, unknown>) => AgentLimitsMessageSchema.safeParse(createEnvelope('agent.limits', p, now)).success;

  it('needs at least one window', () => {
    expect(ok({ observedAt: now })).toBe(false);
    expect(ok({ observedAt: now, fiveHour: win })).toBe(true);
    expect(ok({ observedAt: now, sevenDay: win, claudeSessionId: 's-1' })).toBe(true);
    expect(ok({ observedAt: now, fiveHour: win, sevenDay: win })).toBe(true);
  });

  it('rejects negative percentages', () => {
    expect(ok({ observedAt: now, fiveHour: { usedPct: -1, resetsAt: now } })).toBe(false);
  });
});

describe('heartbeat, ack, nack and unions', () => {
  it('heartbeat payload is fully optional but bounded', () => {
    expect(AgentHeartbeatMessageSchema.safeParse(createEnvelope('agent.heartbeat', {}, now)).success).toBe(true);
    expect(
      AgentHeartbeatMessageSchema.safeParse(
        createEnvelope('agent.heartbeat', { activeSessions: [{ claudeSessionId: 's-1', cwd: '/x', kind: 'bg' }], load: 1.2 }, now),
      ).success,
    ).toBe(true);
    const many = Array.from({ length: AGENT_LIMITS.maxActiveSessions + 1 }, (_, i) => ({ claudeSessionId: `s${i}` }));
    expect(AgentHeartbeatMessageSchema.safeParse(createEnvelope('agent.heartbeat', { activeSessions: many }, now)).success).toBe(false);
  });

  it('ack needs 1..maxAckIds uuids', () => {
    expect(AckMessageSchema.safeParse(createEnvelope('ack', { ids: [randomUUID()] }, now)).success).toBe(true);
    expect(AckMessageSchema.safeParse(createEnvelope('ack', { ids: [] }, now)).success).toBe(false);
    expect(AckMessageSchema.safeParse(createEnvelope('ack', { ids: ['x'] }, now)).success).toBe(false);
  });

  it('nack carries code + retriable', () => {
    const p = { id: randomUUID(), code: 'rate_limited', message: 'slow down', retriable: true, retryAfterMs: 1000 };
    expect(NackMessageSchema.safeParse(createEnvelope('nack', p, now)).success).toBe(true);
    expect(NackMessageSchema.safeParse(createEnvelope('nack', { ...p, code: 'nope' }, now)).success).toBe(false);
  });

  it('AgentToCenterMessage union dispatches on type and rejects auth/ack types', () => {
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('agent.heartbeat', {}, now)).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('agent.events', { events: [event()] }, now)).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('ack', { ids: [randomUUID()] }, now)).success).toBe(false);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('nope', {}, now)).success).toBe(false);
  });
});
