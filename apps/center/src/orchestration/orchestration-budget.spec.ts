import { describe, expect, it, vi } from 'vitest';
import { OrchestrationService } from './orchestration.service.js';

/** 6.11: orkestratsiya mavjud sessiyaga topshirishda qattiq byudjet chegarasi (`budget_exceeded`); `session.prompt` yaratilmaydi. */
type Fire = (plan: unknown, text: string, key: string, actor: unknown, call: unknown, ctx: unknown) => Promise<{ commandId: string | null; failure: string | null }>;

function build(block: unknown): { fire: Fire; create: ReturnType<typeof vi.fn> } {
  const svc = Object.create(OrchestrationService.prototype) as Record<string, unknown>;
  const create = vi.fn(async () => ({ command: { id: 'c1', status: 'sent', errorCode: null } }));
  svc['commands'] = { create };
  svc['budgets'] = { checkSession: vi.fn(async () => block) };
  return { fire: (svc['fire'] as Fire).bind(svc), create };
}
const plan = { mode: 'existing_session', targetSessionId: 'sess-1', step: { key: 's1' }, orchId: 'o1' };

describe('orkestratsiya: byudjet darvozasi', () => {
  it('qattiq chegara: failure=budget_exceeded, buyruq yaratilmaydi', async () => {
    const { fire, create } = build({ scopeKind: 'project', limit: 1 });
    const out = await fire(plan, 'do', 'k', {}, {}, {});
    expect(out).toMatchObject({ commandId: null, failure: 'budget_exceeded' });
    expect(create).not.toHaveBeenCalled();
  });
  it('byudjet yo\'q yoki tekshiruv xato bersa: odatdagidek buyruq yaratiladi', async () => {
    const ok = build(null);
    expect((await ok.fire(plan, 'do', 'k', {}, {}, {})).failure).toBeNull();
    expect(ok.create).toHaveBeenCalledTimes(1);
  });
});
