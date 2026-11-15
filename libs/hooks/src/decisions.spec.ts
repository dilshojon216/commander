import { describe, expect, it } from 'vitest';
import { MailboxCallSchema } from '@commander/contracts';
import { handleMcpMessage, TOOLS } from './cc-mcp-lib.js';
import { renderInboxOutput } from './cc-hook-lib.js';
import type { AgentdReply } from './cc-mcp-lib.js';

function fake(reply: AgentdReply | null) {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, call: async (c: Record<string, unknown>) => (calls.push(c), reply) };
}
const rpc = async (args: Record<string, unknown>, f: ReturnType<typeof fake>) =>
  (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'commander_record_decision', arguments: args } }, f.call)) as { result: { content: Array<{ text: string }>; isError?: boolean } };

describe('commander_record_decision (cc-mcp)', () => {
  it('is listed with required title/decision/reason and optional alternatives', () => {
    const t = TOOLS.find((x) => x.name === 'commander_record_decision')!;
    expect(t.inputSchema.type).toBe('object');
    expect((t.inputSchema as unknown as { required: string[] }).required).toEqual(['title', 'decision', 'reason']);
  });

  it('maps to the record_decision mailbox op that passes the contract schema; returns the center text', async () => {
    const f = fake({ ok: true, data: { text: 'Qaror jurnalga yozildi: Redis' } });
    const r = await rpc({ title: 'Redis', decision: 'Redis ishlatamiz', reason: 'tez', alternatives: ['memcached', 5] }, f);
    expect(r.result.content[0]?.text).toBe('Qaror jurnalga yozildi: Redis');
    expect(f.calls[0]).toEqual({ op: 'record_decision', title: 'Redis', decision: 'Redis ishlatamiz', reason: 'tez', alternatives: ['memcached'] });
    expect(MailboxCallSchema.safeParse(f.calls[0]).success).toBe(true);
  });

  it('missing fields and agentd/center failures are tool errors (never throw)', async () => {
    const f = fake({ ok: true });
    expect((await rpc({ title: 'x' }, f)).result.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await rpc({ title: 'a', decision: 'b', reason: 'c' }, fake(null))).result.isError).toBe(true);
    const rate = await rpc({ title: 'a', decision: 'b', reason: 'c' }, fake({ ok: false, error: { code: 'rate_limited', message: 'Juda tez-tez' } }));
    expect(rate.result.isError).toBe(true);
    expect(rate.result.content[0]?.text).toContain('rate_limited');
  });
});

describe('decisions injection output (UserPromptSubmit --inbox) is fail-safe', () => {
  it('renders additionalContext only for a valid reply; garbage, errors and empty replies produce nothing', () => {
    const block = '[Commander: loyiha qarorlari jurnali. ...]\n- 2026-11-14 Redis: ...';
    expect(JSON.parse(renderInboxOutput({ ok: true, data: { text: block, count: 1, remaining: 0 } })!).hookSpecificOutput.additionalContext).toBe(block);
    expect(renderInboxOutput({ ok: false, error: { code: 'internal', message: 'x' } })).toBeNull();
    expect(renderInboxOutput({ ok: true, data: { text: null, count: 0, remaining: 0 } })).toBeNull();
    expect(renderInboxOutput(null)).toBeNull();
    expect(renderInboxOutput('junk')).toBeNull();
  });
});
