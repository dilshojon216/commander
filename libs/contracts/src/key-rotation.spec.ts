import { describe, expect, it } from 'vitest';
import { AuthOkPayloadSchema, AuthResponsePayloadSchema, AgentToCenterMessageSchema, CenterToAgentMessageSchema } from './agent-protocol.js';
import {
  CenterKeyRotationSchema,
  KeyRotatePayloadSchema,
  KeyRotateResultPayloadSchema,
  buildCenterKeyRotationString,
  buildKeyRotationString,
} from './key-rotation.js';
import { createEnvelope } from './envelope.js';

const K = 'A'.repeat(43);
const S = 'B'.repeat(86);
const DEV = '3f0c9f6e-1b7a-4d77-8d36-0a1b2c3d4e5f';

describe('key rotation strings', () => {
  it('device rotation string is versioned, lower-cases the device id and binds both keys and the timestamp', () => {
    expect(buildKeyRotationString({ deviceId: DEV.toUpperCase(), oldPublicKey: K, newPublicKey: 'C'.repeat(43), ts: 123 })).toBe(
      ['COMMANDER-KEY-ROTATE-V1', DEV, K, 'C'.repeat(43), '123'].join('\n'),
    );
  });

  it('center rotation string binds old key, new key and the overlap window', () => {
    expect(buildCenterKeyRotationString({ previousPublicKey: K, newPublicKey: 'C'.repeat(43), issuedAt: 1, expiresAt: 2 })).toBe(
      ['COMMANDER-CENTER-KEY-ROTATION-V1', K, 'C'.repeat(43), '1', '2'].join('\n'),
    );
  });
});

describe('schemas', () => {
  it('KeyRotatePayload requires raw 32-byte keys and 64-byte signatures', () => {
    expect(KeyRotatePayloadSchema.safeParse({ newPublicKey: K, ts: 1, oldSignature: S, newSignature: S }).success).toBe(true);
    expect(KeyRotatePayloadSchema.safeParse({ newPublicKey: 'short', ts: 1, oldSignature: S, newSignature: S }).success).toBe(false);
    expect(KeyRotatePayloadSchema.safeParse({ newPublicKey: K, ts: 1, oldSignature: 'x', newSignature: S }).success).toBe(false);
  });

  it('the new messages are part of the agent protocol unions; auth.ok/auth.response additions are optional (old peers keep working)', () => {
    const rot = createEnvelope('key.rotate', { newPublicKey: K, ts: 1, oldSignature: S, newSignature: S });
    expect(AgentToCenterMessageSchema.safeParse(rot).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('key.rotate.result', { requestId: rot.id, ok: false, code: 'conflict' })).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('key.rotation_required', {})).success).toBe(true);
    expect(KeyRotateResultPayloadSchema.safeParse({ requestId: rot.id, ok: false, code: 'nope' }).success).toBe(false);

    const base = { deviceId: DEV, ts: 1, signature: S, agentdVersion: '1', hostname: 'h', os: 'linux' };
    expect(AuthResponsePayloadSchema.safeParse(base).success).toBe(true);
    expect(AuthResponsePayloadSchema.safeParse({ ...base, centerKeyFingerprint: '0123456789abcdef' }).success).toBe(true);
    expect(AuthResponsePayloadSchema.safeParse({ ...base, centerKeyFingerprint: 'NOTHEX' }).success).toBe(false);

    const ok = { deviceId: DEV, machineId: DEV, serverTime: 1, heartbeatIntervalMs: 1, heartbeatTimeoutMs: 1, limits: { maxMessageBytes: 1, maxEventsPerBatch: 1, maxUsageRecordsPerBatch: 1, maxMessagesPerMinute: 1 } };
    expect(AuthOkPayloadSchema.safeParse(ok).success).toBe(true);
    const rotation = { previousPublicKey: K, newPublicKey: 'C'.repeat(43), issuedAt: 1, expiresAt: 2, signature: S };
    expect(CenterKeyRotationSchema.safeParse(rotation).success).toBe(true);
    expect(AuthOkPayloadSchema.safeParse({ ...ok, centerKeyRotations: [rotation], rotationRequired: true }).success).toBe(true);
    expect(AuthOkPayloadSchema.safeParse({ ...ok, centerKeyRotations: new Array(9).fill(rotation) }).success).toBe(false);
  });
});
