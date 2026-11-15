import { describe, expect, it } from 'vitest';
import { CreateQueueItemBodySchema, LimitsResponseSchema, QueueItemDtoSchema, QueueTriggerSchema, UpdateQueueItemBodySchema } from './index.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('queue contracts', () => {
  it('trigger turlari; cron timezone default; noma\'lum kalit rad', () => {
    expect(QueueTriggerSchema.parse({ type: 'cron', cron: '0 2 * * *' })).toEqual({ type: 'cron', cron: '0 2 * * *', timezone: 'Asia/Tashkent' });
    expect(QueueTriggerSchema.safeParse({ type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }).success).toBe(false);
    expect(QueueTriggerSchema.safeParse({ type: 'limit_reset', window: '1h' }).success).toBe(false);
    expect(QueueTriggerSchema.safeParse({ type: 'at', at: 'tomorrow' }).success).toBe(false);
    expect(QueueTriggerSchema.safeParse({ type: 'now', extra: 1 }).success).toBe(false);
  });
  it('yaratish tanasi: bypassPermissions/strict kalitlar rad, auto ruxsat etilgan sxemada', () => {
    const ok = { machineId: UUID, cwd: '/x', prompt: 'p', permissionMode: 'plan', trigger: { type: 'now' } };
    expect(CreateQueueItemBodySchema.safeParse(ok).success).toBe(true);
    expect(CreateQueueItemBodySchema.safeParse({ ...ok, permissionMode: 'bypassPermissions' }).success).toBe(false);
    expect(CreateQueueItemBodySchema.safeParse({ ...ok, dangerouslySkipPermissions: true }).success).toBe(false);
    expect(CreateQueueItemBodySchema.safeParse({ ...ok, prompt: 'x'.repeat(16_001) }).success).toBe(false);
  });
  it('yangilash: bo\'sh tana va cwd/machine o\'zgartirish rad', () => {
    expect(UpdateQueueItemBodySchema.safeParse({}).success).toBe(false);
    expect(UpdateQueueItemBodySchema.safeParse({ cwd: '/etc' }).success).toBe(false);
    expect(UpdateQueueItemBodySchema.safeParse({ model: null, trigger: { type: 'machine_idle' } }).success).toBe(true);
  });
  it('DTO sxemasida prompt maydoni yo\'q (faqat preview)', () => {
    expect(Object.keys(QueueItemDtoSchema.shape)).not.toContain('prompt');
    expect(Object.keys(QueueItemDtoSchema.shape)).toContain('promptPreview');
  });
  it('limits forecast additiv: yo\'q ham, null ham yaroqli', () => {
    const w = { usedPct: 1, resetsAt: null, observedAt: null, source: 'official', stale: false, ageSeconds: null, reset: false, observedByMachineId: null, anchor: null, calibration: null };
    const base = { computedAt: new Date().toISOString(), freshSeconds: 180, sevenDay: null };
    expect(LimitsResponseSchema.safeParse({ ...base, fiveHour: w }).success).toBe(true);
    expect(LimitsResponseSchema.safeParse({ ...base, fiveHour: { ...w, forecast: null } }).success).toBe(true);
  });
});
