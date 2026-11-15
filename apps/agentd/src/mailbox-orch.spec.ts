import { describe, expect, it } from 'vitest';
import type { MailboxReplyPayload } from '@commander/contracts';
import { MailboxHandler } from './mailbox-handler.js';
import type { MailboxIpcReply } from './mailbox-handler.js';
import type { MailboxClient } from './mailbox-client.js';
import type { SessionStore } from './session-store.js';

/** Orkestratsiya chaqiruvlari agentd'dan markazga ketishdan OLDIN redakt qilinadi (qoida 5). */
function setup(): { handler: MailboxHandler; sent: Array<{ sid: string; call: Record<string, unknown> }> } {
  const sent: Array<{ sid: string; call: Record<string, unknown> }> = [];
  const client = {
    request: async (sid: string, call: Record<string, unknown>): Promise<MailboxReplyPayload> => {
      sent.push({ sid, call });
      return { reqId: '00000000-0000-4000-8000-000000000000', ok: true, data: { text: 'ok' } };
    },
  } as unknown as MailboxClient;
  const store = { listOpen: () => [] } as unknown as SessionStore;
  const log = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined } as never;
  return { handler: new MailboxHandler({ client, store, log }), sent };
}
const run = async (h: MailboxHandler, payload: unknown): Promise<MailboxIpcReply> => {
  let out: MailboxIpcReply | null = null;
  await h.handle(payload, { reply: (r) => void (out = r) });
  return out as unknown as MailboxIpcReply;
};

describe('MailboxHandler: orkestratsiya', () => {
  it('maqsad, qadam sarlavhasi, prompt va natijadagi sirlar markazga ketishdan oldin maskalanadi', async () => {
    const { handler, sent } = setup();
    const secret = 'token=sk-ant-abcdefghijklmnop';
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_plan', goal: `goal ${secret}`, steps: [{ title: `t ${secret}`, role: 'backend' }] } })).ok).toBe(true);
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_dispatch', stepId: 'a', mode: 'new_session', prompt: `p ${secret}`, cwd: '/x' } })).ok).toBe(true);
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_step_update', stepId: 'a', status: 'done', summary: `s ${secret}` } })).ok).toBe(true);
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_status' } })).ok).toBe(true);
    expect(sent).toHaveLength(4);
    expect(JSON.stringify(sent)).not.toContain('sk-ant-abcdefghijklmnop');
    expect(JSON.stringify(sent)).toContain('[REDACTED]');
    expect(sent.every((s) => s.sid === 's1')).toBe(true);
  });

  it("sessiya aniqlanmasa (env ham, cwd ham yo'q) markazga HECH NARSA ketmaydi: session_unknown", async () => {
    const { handler, sent } = setup();
    const r = await run(handler, { call: { op: 'orch_status' } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('session_unknown');
    expect(sent).toHaveLength(0);
  });

  it("yaroqsiz orkestratsiya chaqiruvi (auto rejim, 'cancelled' status) rad etiladi va markazga bormaydi", async () => {
    const { handler, sent } = setup();
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_dispatch', stepId: 'a', mode: 'new_session', prompt: 'p', permissionMode: 'auto' } })).error?.code).toBe('invalid_request');
    expect((await run(handler, { sessionId: 's1', call: { op: 'orch_step_update', stepId: 'a', status: 'cancelled' } })).error?.code).toBe('invalid_request');
    expect(sent).toHaveLength(0);
  });
});
