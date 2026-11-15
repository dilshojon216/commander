import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACKED_MESSAGE_TYPES,
  AGENT_MESSAGE_TYPES,
  APPROVAL_LIMITS,
  AgentToCenterMessageSchema,
  ApprovalCancelMessageSchema,
  ApprovalDecisionBodySchema,
  ApprovalDecisionMessageSchema,
  ApprovalDtoSchema,
  ApprovalExpiredMessageSchema,
  ApprovalRequestMessageSchema,
  CenterToAgentMessageSchema,
  ListApprovalsQuerySchema,
  createEnvelope,
} from './index.js';

const request = (over: Record<string, unknown> = {}) => ({
  approvalId: randomUUID(),
  claudeSessionId: 's-1',
  toolName: 'Bash',
  toolInputRedacted: '{"command":"npm test"}',
  toolInputFullHash: 'a'.repeat(64),
  cwd: '/work/commander',
  deadline: Date.now() + 300_000,
  ...over,
});

describe('approval agent messages', () => {
  it('accepts a valid approval.request and routes it through the agent->center union', () => {
    const env = createEnvelope('approval.request', request());
    expect(ApprovalRequestMessageSchema.safeParse(env).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(env).success).toBe(true);
  });

  it('caps toolInputRedacted at APPROVAL_LIMITS.toolInputMaxChars (the raw input must never be sent whole)', () => {
    const max = APPROVAL_LIMITS.toolInputMaxChars;
    expect(ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request({ toolInputRedacted: 'x'.repeat(max) }))).success).toBe(true);
    expect(ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request({ toolInputRedacted: 'x'.repeat(max + 1) }))).success).toBe(false);
  });

  it('rejects a malformed approvalId, hash, empty tool name and a non-integer deadline', () => {
    for (const bad of [{ approvalId: 'nope' }, { toolInputFullHash: 'A'.repeat(64) }, { toolInputFullHash: 'a'.repeat(63) }, { toolName: '' }, { deadline: 1.5 }, { cwd: '' }]) {
      expect(ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request(bad))).success).toBe(false);
    }
  });

  it('approval.cancel needs an approvalId; reason is optional and short', () => {
    expect(ApprovalCancelMessageSchema.safeParse(createEnvelope('approval.cancel', { approvalId: randomUUID() })).success).toBe(true);
    expect(ApprovalCancelMessageSchema.safeParse(createEnvelope('approval.cancel', { approvalId: randomUUID(), reason: 'resolved_locally' })).success).toBe(true);
    expect(ApprovalCancelMessageSchema.safeParse(createEnvelope('approval.cancel', { approvalId: randomUUID(), reason: 'x'.repeat(65) })).success).toBe(false);
    expect(ApprovalCancelMessageSchema.safeParse(createEnvelope('approval.cancel', {})).success).toBe(false);
  });

  it('center->agent decision and expired shapes; both are in the center->agent union', () => {
    const id = randomUUID();
    const dec = createEnvelope('approval.decision', { approvalId: id, behavior: 'deny', message: 'not now', decidedAt: Date.now() });
    expect(ApprovalDecisionMessageSchema.safeParse(dec).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(dec).success).toBe(true);
    expect(ApprovalDecisionMessageSchema.safeParse(createEnvelope('approval.decision', { approvalId: id, behavior: 'always', decidedAt: 1 })).success).toBe(false);
    const exp = createEnvelope('approval.expired', { approvalId: id, expiredAt: Date.now() });
    expect(ApprovalExpiredMessageSchema.safeParse(exp).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(exp).success).toBe(true);
  });

  it('approval messages are acked by the center; every agent message type is declared', () => {
    expect(ACKED_MESSAGE_TYPES).toContain('approval.request');
    expect(ACKED_MESSAGE_TYPES).toContain('approval.cancel');
    expect([...AGENT_MESSAGE_TYPES].sort()).toEqual(['agent.events', 'agent.health', 'agent.heartbeat', 'agent.limits', 'agent.project_snapshot', 'agent.usage', 'approval.cancel', 'approval.request', 'chat.error', 'chat.items', 'command.ack', 'command.result', 'config.chunk', 'key.rotate', 'logs.chunk', 'mailbox.request']);
  });
});

describe('approval REST DTOs', () => {
  it('decision body: allow|deny, optional message, strict (no extra fields such as permission suggestions)', () => {
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'allow' }).success).toBe(true);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'deny', message: 'no' }).success).toBe(true);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'maybe' }).success).toBe(false);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'allow', alwaysAllow: true }).success).toBe(false);
    expect(ApprovalDecisionBodySchema.safeParse({ behavior: 'deny', message: 'x'.repeat(APPROVAL_LIMITS.messageMaxChars + 1) }).success).toBe(false);
  });

  it('list query: recentLimit defaults to 20 and is bounded; unknown keys rejected', () => {
    expect(ListApprovalsQuerySchema.parse({}).recentLimit).toBe(20);
    expect(ListApprovalsQuerySchema.safeParse({ recentLimit: '101' }).success).toBe(false);
    expect(ListApprovalsQuerySchema.safeParse({ x: 1 }).success).toBe(false);
  });

  it('approval DTO has no raw tool input field', () => {
    const dto = {
      id: randomUUID(), machineId: randomUUID(), machineSlug: 'mac', sessionId: null, claudeSessionId: 's', projectName: null, cwd: '/x', toolName: 'Bash',
      toolInputRedacted: '{}', toolInputFullHash: 'a'.repeat(64), status: 'pending', behavior: null, decisionMessage: null, decidedByDeviceId: null, decidedAt: null,
      delivered: null, requestedAt: '2026-11-13T10:00:00.000Z', deadline: '2026-11-13T10:05:00.000Z', resolvedAt: null,
    };
    expect(ApprovalDtoSchema.safeParse(dto).success).toBe(true);
    expect(Object.keys(ApprovalDtoSchema.shape)).not.toContain('toolInput');
  });
});

describe('2.13/2.14 kengaytmalar (additiv)', () => {
  it("eski agentd so'rovi (kind/target/plan yo'q) kind=tool bilan o'tadi", () => {
    const r = ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request()));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payload.kind).toBe('tool');
  });
  it('target: {path|null, insideCwd}; noma\'lum shakl rad', () => {
    const ok = (target: unknown) => ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request({ target }))).success;
    expect(ok({ path: 'src/a.ts', insideCwd: true })).toBe(true);
    expect(ok({ path: null, insideCwd: false })).toBe(true);
    expect(ok({ path: '', insideCwd: true })).toBe(false);
    expect(ok({ insideCwd: true })).toBe(false);
    expect(ok({ path: 'a'.repeat(APPROVAL_LIMITS.targetPathMaxChars + 1), insideCwd: true })).toBe(false);
  });
  it("plan: kind=plan faqat matn bilan, 16 KB gacha; matn faqat kind=plan uchun", () => {
    const ok = (over: Record<string, unknown>) => ApprovalRequestMessageSchema.safeParse(createEnvelope('approval.request', request(over))).success;
    expect(ok({ kind: 'plan', plan: '# r' })).toBe(true);
    expect(ok({ kind: 'plan' })).toBe(false);
    expect(ok({ plan: '# r' })).toBe(false);
    expect(ok({ kind: 'plan', plan: 'x'.repeat(APPROVAL_LIMITS.planMaxChars) })).toBe(true);
    expect(ok({ kind: 'plan', plan: 'x'.repeat(APPROVAL_LIMITS.planMaxChars + 1) })).toBe(false);
  });
});
