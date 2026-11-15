import { describe, expect, it } from 'vitest';
import { effectiveColumn } from './task-board.js';
import { diffTaskStatuses } from './task-events.js';
import { addDays, daysBetween, isValidDay, tashkentDayOf, tashkentDayRange } from './tashkent-day.js';

describe('effectiveColumn', () => {
  it('TASKS.md done har doim ustun (overlay va faol span e\'tiborsiz)', () => {
    expect(effectiveColumn({ mdStatus: 'done', overlay: 'review', hasActiveSpan: true })).toEqual({ column: 'done', source: 'tasks_md' });
    expect(effectiveColumn({ mdStatus: 'done', overlay: null, hasActiveSpan: false })).toEqual({ column: 'done', source: 'tasks_md' });
  });
  it('overlay bo\'lsa u (done ham: TASKS.md hali todo bo\'lsa ham)', () => {
    expect(effectiveColumn({ mdStatus: 'todo', overlay: 'review', hasActiveSpan: false })).toEqual({ column: 'review', source: 'board' });
    expect(effectiveColumn({ mdStatus: 'doing', overlay: 'todo', hasActiveSpan: true })).toEqual({ column: 'todo', source: 'board' });
    expect(effectiveColumn({ mdStatus: 'todo', overlay: 'done', hasActiveSpan: false })).toEqual({ column: 'done', source: 'board' });
  });
  it('hisoblangan: faol span yoki TASKS.md doing -> doing, aks holda todo', () => {
    expect(effectiveColumn({ mdStatus: 'todo', overlay: null, hasActiveSpan: true })).toEqual({ column: 'doing', source: 'derived' });
    expect(effectiveColumn({ mdStatus: 'doing', overlay: null, hasActiveSpan: false })).toEqual({ column: 'doing', source: 'derived' });
    expect(effectiveColumn({ mdStatus: 'todo', overlay: null, hasActiveSpan: false })).toEqual({ column: 'todo', source: 'derived' });
    expect(effectiveColumn({ mdStatus: 'unknown', overlay: null, hasActiveSpan: false })).toEqual({ column: 'todo', source: 'derived' });
  });
});

describe('diffTaskStatuses (task_events snapshot farqidan)', () => {
  const prev = new Map([['1.1', 'todo'], ['1.2', 'doing'], ['1.3', 'done'], ['1.9', 'todo']]);
  it('faqat o\'zgargan holatlar; yangi todo va o\'chirilgan vazifa jurnalga tushmaydi', () => {
    const next = [
      { key: '1.1', status: 'done' as const },
      { key: '1.2', status: 'done' as const },
      { key: '1.3', status: 'done' as const },
      { key: '1.4', status: 'todo' as const },
      { key: '1.5', status: 'done' as const },
    ];
    expect(diffTaskStatuses(prev, next)).toEqual([
      { taskKey: '1.1', from: 'todo', to: 'done' },
      { taskKey: '1.2', from: 'doing', to: 'done' },
      { taskKey: '1.5', from: null, to: 'done' },
    ]);
  });
  it('birinchi snapshot (oldingi vazifalar yo\'q): hech narsa', () => {
    expect(diffTaskStatuses(new Map(), [{ key: '1.1', status: 'done' }])).toEqual([]);
  });
  it('qayta bajarilgan-qaytarilgan (done -> todo) ham yoziladi', () => {
    expect(diffTaskStatuses(new Map([['1.1', 'done']]), [{ key: '1.1', status: 'todo' }])).toEqual([{ taskKey: '1.1', from: 'done', to: 'todo' }]);
  });
});

describe('Toshkent kun chegaralari', () => {
  it('kun UTC+5: 2026-11-13 = 2026-11-12T19:00Z .. 2026-11-13T19:00Z', () => {
    const r = tashkentDayRange('2026-11-13');
    expect(r.start.toISOString()).toBe('2026-11-12T19:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-13T19:00:00.000Z');
  });
  it('tashkentDayOf: 18:59Z va 19:00Z turli kunlar', () => {
    expect(tashkentDayOf(new Date('2026-11-12T18:59:59Z'))).toBe('2026-11-12');
    expect(tashkentDayOf(new Date('2026-11-12T19:00:00Z'))).toBe('2026-11-13');
  });
  it('yordamchilar', () => {
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('2026-11-13')).toBe(true);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-11-11', '2026-11-13')).toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
  });
});
