import { describe, expect, it } from 'vitest';
import type { QueueItemDto } from '@commander/contracts';
import { formatForecastAlert, formatQueueList, formatQueued, fmtTashkent, queueErrorTextUz, triggerLabel } from './queue-telegram-format.js';

const now = new Date('2026-11-13T10:00:00Z'); // 15:00 Toshkent
const item = (o: Partial<QueueItemDto> = {}): QueueItemDto => ({
  id: '11111111-1111-4111-8111-111111111111', projectId: null, machineId: '22222222-2222-4222-8222-222222222222', machineSlug: 'mac<book>', cwd: '/Users/me/proj',
  promptPreview: 'run <tests> token=[REDACTED]', promptLength: 30, model: 'haiku', permissionMode: 'plan', name: null, taskKey: null,
  trigger: { type: 'cron', cron: '0 2 * * *', timezone: 'Asia/Tashkent' }, status: 'waiting_trigger', attempts: 0, lastError: null, lastErrorCode: null,
  createdByDeviceId: '33333333-3333-4333-8333-333333333333', confirmation: 'telegram_inline', confirmedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(),
  nextRunAt: '2026-11-13T21:00:00.000Z', lastSessionId: null, lastCommandId: null, runCount: 0, lastRunAt: null, ...o,
});

describe('telegram queue format', () => {
  it('Toshkent vaqti', () => {
    expect(fmtTashkent('2026-11-13T10:40:00Z', now)).toBe('15:40');
    expect(fmtTashkent('2026-11-13T21:00:00Z', now)).toBe('14-noy 02:00');
  });
  it('trigger yorliqlari', () => {
    expect(triggerLabel({ type: 'cron', cron: '0 2 * * *', timezone: 'Asia/Tashkent' }, null, now)).toBe('takroriy: Har kecha 02:00');
    expect(triggerLabel({ type: 'limit_reset', window: '5h' }, '2026-11-13T12:00:00Z', now)).toContain('≈ 17:00');
    expect(triggerLabel({ type: 'machine_idle' }, null, now)).toContain('bo\'sh');
  });
  it('ro\'yxat HTML-escape, prompt faqat redakt ko\'rinishda', () => {
    const out = formatQueueList([item()], now);
    expect(out).toContain('mac&lt;book&gt;');
    expect(out).toContain('run &lt;tests&gt; token=[REDACTED]');
    expect(out).not.toContain('<tests>');
    expect(formatQueueList([], now)).toContain('bo\'sh');
    expect(formatQueued(item(), now)).toContain('Navbatga qo\'yildi');
  });
  it('bashorat ogohlantirishi: taxmin belgisi va reset vaqti', () => {
    const view = { usedPct: 91.2, resetsAt: '2026-11-13T12:00:00Z' } as never;
    const out = formatForecastAlert({ view, forecast: { exhaustsAt: '2026-11-13T10:25:00Z', beforeReset: true, resetsAt: '2026-11-13T12:00:00Z', ratePctPerHour: 18, basisMinutes: 30, basisWeightedTokens: 1, confidence: 'high', source: 'official' } }, now);
    expect(out).toContain('≈ 15:25');
    expect(out).toContain('Yangilanish: 17:00');
    expect(out).toContain('taxmin');
  });
  it('xato matnlari', () => {
    expect(queueErrorTextUz('policy_disabled')).toContain('yoqilmagan');
    expect(queueErrorTextUz('zzz')).toContain('qo\'yib bo\'lmadi');
  });
});
