import { describe, expect, it } from 'vitest';
import type { OrchestrationDto } from '@commander/contracts';
import { formatOrchList, formatOrchNotice } from './orchestration-format.js';

const dto = (over: Partial<OrchestrationDto> = {}): OrchestrationDto => ({
  id: '12345678-0000-4000-8000-000000000000',
  goal: 'Add <b>phone</b> field token=[REDACTED]',
  groupKey: 'g',
  status: 'running',
  origin: 'dashboard',
  taskKey: null,
  projectId: null,
  leadSessionId: null,
  leadLabel: null,
  leadCommandId: null,
  confirmation: null,
  tokenBudget: 2_000_000,
  tokensUsed: 2_100_000,
  budgetExceeded: true,
  maxConcurrent: 3,
  cancelReason: 'owner',
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
  finishedAt: null,
  counts: { pending: 0, dispatched: 0, running: 0, done: 1, failed: 1, cancelled: 0 },
  steps: [
    { id: '00000000-0000-4000-8000-000000000001', key: 'api', position: 0, title: 'SECRET step title', role: 'backend', machine: null, cwd: null, dependsOn: [], status: 'done', assignedSessionId: null, assignedLabel: null, dispatchMode: null, queueItemId: null, commandId: null, resultSummary: 'SECRET RESULT', lastError: null, dispatchedAt: null, finishedAt: null },
    { id: '00000000-0000-4000-8000-000000000002', key: 'ui', position: 1, title: 'UI', role: 'frontend', machine: null, cwd: null, dependsOn: ['api'], status: 'failed', assignedSessionId: null, assignedLabel: null, dispatchMode: null, queueItemId: null, commandId: null, resultSummary: null, lastError: 'session_ended', dispatchedAt: null, finishedAt: null },
  ],
  ...over,
});

describe('Telegram bildirishnomalari', () => {
  it('boshlandi/tugadi/xato/bekor/byudjet: HTML-escape; natija matni va qadam sarlavhalari yuborilmaydi', () => {
    for (const kind of ['started', 'completed', 'failed', 'cancelled', 'budget'] as const) {
      const t = formatOrchNotice(kind, dto());
      expect(t).toContain('#12345678');
      expect(t).toContain('Add &lt;b&gt;phone&lt;/b&gt;');
      expect(t).not.toContain('<b>phone</b>');
      expect(t).not.toContain('SECRET');
      expect(t.length).toBeLessThan(900);
    }
  });
  it('xato xabari xato qadam kalitlari va sababini ko\'rsatadi; byudjet xabari raqamlar bilan', () => {
    expect(formatOrchNotice('failed', dto())).toContain('ui (session_ended)');
    expect(formatOrchNotice('budget', dto())).toContain('2,100,000 / 2,000,000');
    expect(formatOrchNotice('cancelled', dto())).toContain('sabab: owner');
    expect(formatOrchNotice('completed', dto())).toContain('1/2 qadam bajarildi');
  });
  it('/orch ro\'yxati: bo\'sh va to\'ldirilgan', () => {
    expect(formatOrchList([])).toBe("Orkestratsiyalar yo'q.");
    const t = formatOrchList([dto(), dto({ id: '99999999-0000-4000-8000-000000000000', status: 'completed' })]);
    expect(t).toContain('12345678');
    expect(t).toContain('ishlamoqda');
    expect(t).toContain('tugadi');
    expect(t).not.toContain('SECRET');
  });
});
