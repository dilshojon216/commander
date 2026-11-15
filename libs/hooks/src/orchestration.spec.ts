import { describe, expect, it } from 'vitest';
import { MailboxCallSchema } from '@commander/contracts';
import { handleMcpMessage, TOOLS } from './cc-mcp-lib.js';
import type { AgentdReply } from './cc-mcp-lib.js';

/** Soxta agentd: oxirgi chaqiruvni yozib oladi. */
function fake(reply: AgentdReply | null): { calls: Array<Record<string, unknown>>; call: (c: Record<string, unknown>) => Promise<AgentdReply | null> } {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, call: async (c) => (calls.push(c), reply) };
}

const rpc = async (name: string, args: Record<string, unknown>, f: ReturnType<typeof fake>) =>
  (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, f.call)) as { result: { content: Array<{ text: string }>; isError?: boolean } };

describe('orkestratsiya vositalari (cc-mcp)', () => {
  it('tools/list: 4 ta orkestratsiya vositasi, sxemalar obyekt, steps maxItems 20', async () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['commander_plan_create', 'commander_dispatch', 'commander_step_update', 'commander_orchestration_status']) expect(names).toContain(n);
    const plan = TOOLS.find((t) => t.name === 'commander_plan_create')!;
    expect(plan.inputSchema.type).toBe('object');
    expect((plan.inputSchema as unknown as { properties: { steps: { maxItems: number } } }).properties.steps.maxItems).toBe(20);
    expect((TOOLS.find((t) => t.name === 'commander_dispatch')!.inputSchema as unknown as { properties: { mode: { enum: string[] } } }).properties.mode.enum).toEqual(['existing_session', 'new_session', 'queue']);
  });

  it("plan_create -> orch_plan; chaqiruv kontrakt sxemasidan o'tadi; natija matni qaytadi", async () => {
    const f = fake({ ok: true, data: { text: 'Reja qabul qilindi: 2 ta qadam.' } });
    const r = await rpc('commander_plan_create', { goal: 'g', steps: [{ key: 'api', title: 'API', role: 'backend' }, { key: 'ui', title: 'UI', role: 'frontend', depends_on: ['api'] }] }, f);
    expect(r.result.content[0]?.text).toBe('Reja qabul qilindi: 2 ta qadam.');
    expect(r.result.isError).toBeUndefined();
    expect(f.calls[0]).toMatchObject({ op: 'orch_plan', goal: 'g' });
    expect(MailboxCallSchema.safeParse(f.calls[0]).success).toBe(true);
  });

  it("dispatch -> orch_dispatch (faqat berilgan maydonlar), step_update -> orch_step_update, status -> orch_status; hammasi sxemadan o'tadi", async () => {
    const f = fake({ ok: true, data: { text: 'ok' } });
    await rpc('commander_dispatch', { stepId: 'api', mode: 'new_session', prompt: 'do it', cwd: '/x/api', permissionMode: 'plan', extra: 'ignored' }, f);
    await rpc('commander_step_update', { stepId: 'api', status: 'done', summary: 's' }, f);
    await rpc('commander_step_update', { stepId: 'api', status: 'in_progress' }, f);
    await rpc('commander_orchestration_status', {}, f);
    expect(f.calls[0]).toEqual({ op: 'orch_dispatch', stepId: 'api', mode: 'new_session', prompt: 'do it', cwd: '/x/api', permissionMode: 'plan' });
    expect(f.calls[1]).toEqual({ op: 'orch_step_update', stepId: 'api', status: 'done', summary: 's' });
    expect(f.calls[2]).toEqual({ op: 'orch_step_update', stepId: 'api', status: 'in_progress' });
    expect(f.calls[3]).toEqual({ op: 'orch_status' });
    for (const c of f.calls) expect(MailboxCallSchema.safeParse(c).success).toBe(true);
  });

  it("noto'g'ri argument agentd'ga bormaydi; center xatosi va agentd yo'qligi xato matni bo'ladi", async () => {
    const f = fake({ ok: true, data: { text: 'x' } });
    expect((await rpc('commander_plan_create', { goal: 'g' }, f)).result.isError).toBe(true);
    expect((await rpc('commander_dispatch', { stepId: 'a' }, f)).result.isError).toBe(true);
    expect((await rpc('commander_step_update', { stepId: 'a' }, f)).result.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const denied = await rpc('commander_step_update', { stepId: 'a', status: 'done' }, fake({ ok: false, error: { code: 'orch_forbidden', message: 'faqat tayinlangan sessiya' } }));
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text).toContain('orch_forbidden');
    expect((await rpc('commander_orchestration_status', {}, fake(null))).result.isError).toBe(true);
  });

  it("kontrakt sxemasi yaroqsiz qiymatlarni rad etadi (21 qadam, 'auto' rejim, noma'lum status, ortiqcha maydon)", () => {
    const step = { title: 't', role: 'backend' };
    expect(MailboxCallSchema.safeParse({ op: 'orch_plan', goal: 'g', steps: Array.from({ length: 21 }, () => step) }).success).toBe(false);
    expect(MailboxCallSchema.safeParse({ op: 'orch_dispatch', stepId: 'a', mode: 'new_session', prompt: 'p', permissionMode: 'auto' }).success).toBe(false);
    expect(MailboxCallSchema.safeParse({ op: 'orch_dispatch', stepId: 'a', mode: 'bogus', prompt: 'p' }).success).toBe(false);
    expect(MailboxCallSchema.safeParse({ op: 'orch_step_update', stepId: 'a', status: 'cancelled' }).success).toBe(false);
    expect(MailboxCallSchema.safeParse({ op: 'orch_step_update', stepId: 'a', status: 'done', extra: 1 }).success).toBe(false);
    expect(MailboxCallSchema.safeParse({ op: 'orch_plan', goal: 'g', steps: [{ ...step, role: 'Back End!' }] }).success).toBe(false);
  });
});
