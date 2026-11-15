import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentToCenterMessageSchema, CenterToAgentMessageSchema } from './agent-protocol.js';
import { CHAT_LIMITS, ChatItemSchema, ChatOpenPayloadSchema } from './chat.js';
import { ClientToServerMessageSchema, ServerToClientMessageSchema } from './client-protocol.js';
import { createEnvelope } from './envelope.js';

const sid = randomUUID();

describe('ChatItem', () => {
  it('har tur uchun yaroqli namunani qabul qiladi', () => {
    const items = [
      { kind: 'user', id: 'u1', ts: 1, text: 'salom' },
      { kind: 'assistant', id: 'a1', ts: 2, text: '# md', requestId: 'req_1', model: 'm' },
      { kind: 'thinking', id: 't1', ts: 2, text: '...' },
      { kind: 'tool_use', id: 'a2', ts: 3, toolUseId: 'toolu_1', toolName: 'Edit', summary: 'Edit: a.ts (+1 -0)', lines: { added: 1, removed: 0 } },
      { kind: 'tool_result', id: 'r1', ts: 4, toolUseId: 'toolu_1', ok: false, text: 'x', truncated: false },
      { kind: 'notice', id: 'n1', ts: 5, code: 'compact', level: 'info', text: 'compact' },
      { kind: 'usage', id: 'usage:req_1', ts: 6, requestId: 'req_1', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 },
    ];
    for (const i of items) expect(ChatItemSchema.safeParse(i).success).toBe(true);
  });

  it('chegaralardan oshganini rad etadi', () => {
    expect(ChatItemSchema.safeParse({ kind: 'user', id: 'u', ts: 1, text: 'x'.repeat(CHAT_LIMITS.maxTextChars + 1) }).success).toBe(false);
    expect(ChatItemSchema.safeParse({ kind: 'tool_result', id: 'r', ts: 1, toolUseId: 't', ok: true, text: 'x'.repeat(CHAT_LIMITS.maxToolResultBytes + 1), truncated: true }).success).toBe(false);
    expect(ChatItemSchema.safeParse({ kind: 'unknown', id: 'r', ts: 1 }).success).toBe(false);
  });
});

describe('chat xabarlari', () => {
  it('klient -> center: chat.open / chat.close', () => {
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('chat.open', { sessionId: sid, limit: 200 })).success).toBe(true);
    expect(ClientToServerMessageSchema.safeParse(createEnvelope('chat.close', { sessionId: sid })).success).toBe(true);
    expect(ChatOpenPayloadSchema.safeParse({ sessionId: 'x' }).success).toBe(false);
    expect(ChatOpenPayloadSchema.safeParse({ sessionId: sid, limit: CHAT_LIMITS.maxTail + 1 }).success).toBe(false);
  });

  it('center -> klient: chat.items / chat.state', () => {
    expect(ServerToClientMessageSchema.safeParse(createEnvelope('chat.items', { sessionId: sid, items: [], replace: true, cursor: null })).success).toBe(true);
    expect(ServerToClientMessageSchema.safeParse(createEnvelope('chat.state', { sessionId: sid, state: 'offline' })).success).toBe(true);
    expect(ServerToClientMessageSchema.safeParse(createEnvelope('chat.state', { sessionId: sid, state: 'bogus' })).success).toBe(false);
  });

  it('center <-> agent', () => {
    const streamId = randomUUID();
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('chat.stream.start', { streamId, claudeSessionId: 's', tail: 200 })).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('chat.stream.stop', { streamId })).success).toBe(true);
    expect(CenterToAgentMessageSchema.safeParse(createEnvelope('chat.stream.page', { streamId, pageId: randomUUID(), before: 'o123', limit: 50 })).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('chat.items', { streamId, items: [], done: true })).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('chat.error', { streamId, code: 'not_found' })).success).toBe(true);
    expect(AgentToCenterMessageSchema.safeParse(createEnvelope('chat.error', { streamId, code: 'weird' })).success).toBe(false);
  });
});
