import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_SETTINGS } from '@commander/contracts';
import type { ReportSettings } from '@commander/contracts';
import { buildReport, duePeriods, modelFamily, normalizeSettings, periodFor, recommend, tashkentClock } from './report-logic.js';
import type { ModelRow, ReportInput, TaskModelRow, TaskStatRow } from './report-logic.js';

// Toshkent = UTC+5. 2026-11-15 yakshanba.
const TK = (day: string, hm: string): Date => new Date(Date.parse(`${day}T${hm}:00Z`) - 5 * 3_600_000);
const P1 = '33333333-3333-4333-8333-333333333333';
const P2 = '44444444-4444-4444-8444-444444444444';

describe('davr va jadval (vaqt sayohati, Asia/Tashkent)', () => {
  it('tashkentClock: UTC 19:30 = Toshkent 00:30 ertasi', () => {
    expect(tashkentClock(new Date('2026-11-13T19:30:00Z'))).toEqual({ day: '2026-11-14', minutes: 30, weekday: 6 });
  });

  it('periodFor: kunlik = bitta kun, haftalik = oxirgi 7 kun', () => {
    expect(periodFor('daily', '2026-11-15')).toEqual({ kind: 'daily', from: '2026-11-15', to: '2026-11-15' });
    expect(periodFor('weekly', '2026-11-15')).toEqual({ kind: 'weekly', from: '2026-11-09', to: '2026-11-15' });
  });

  it('kunlik 21:00: 20:59 yo\'q, 21:00 bor, yaratilgan bo\'lsa yo\'q', () => {
    const s = DEFAULT_REPORT_SETTINGS;
    expect(duePeriods(s, TK('2026-11-13', '20:59'), new Set())).toEqual([]);
    expect(duePeriods(s, TK('2026-11-13', '21:00'), new Set())).toEqual([periodFor('daily', '2026-11-13')]);
    expect(duePeriods(s, TK('2026-11-13', '23:30'), new Set(['daily|2026-11-13']))).toEqual([]);
  });

  it('haftalik: yakshanba 20:00 dan keyin; boshqa kunlari yo\'q; yakshanba kuni ikkalasi ham', () => {
    const s = DEFAULT_REPORT_SETTINGS;
    expect(duePeriods(s, TK('2026-11-14', '22:00'), new Set(['daily|2026-11-14'])).map((p) => p.kind)).toEqual([]);
    expect(duePeriods(s, TK('2026-11-15', '19:59'), new Set())).toEqual([]);
    expect(duePeriods(s, TK('2026-11-15', '20:00'), new Set()).map((p) => p.kind)).toEqual(['weekly']);
    expect(duePeriods(s, TK('2026-11-15', '21:05'), new Set()).map((p) => p.kind)).toEqual(['daily', 'weekly']);
  });

  it('o\'chirilgan va sozlangan vaqt', () => {
    const s: ReportSettings = { ...DEFAULT_REPORT_SETTINGS, dailyEnabled: false, weeklyTime: '08:00', weeklyDay: 1 };
    expect(duePeriods(s, TK('2026-11-16', '07:59'), new Set())).toEqual([]);
    expect(duePeriods(s, TK('2026-11-16', '08:00'), new Set()).map((p) => p.kind)).toEqual(['weekly']);
  });

  it('normalizeSettings yaroqsiz qiymatni defaultga qaytaradi', () => {
    expect(normalizeSettings({ dailyTime: '25:00', weeklyDay: 9, dailyEnabled: false })).toEqual({ ...DEFAULT_REPORT_SETTINGS, dailyEnabled: false });
    expect(normalizeSettings(null)).toEqual(DEFAULT_REPORT_SETTINGS);
  });
});

const model = (over: Partial<ModelRow>): ModelRow => ({ projectId: P1, model: 'claude-sonnet-5-5', input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0, cost: 0.5, requests: 10, ...over });
const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  period: periodFor('daily', '2026-11-13'),
  projects: [{ id: P1, name: 'commander' }, { id: P2, name: 'iot' }],
  models: [],
  closed: [],
  commits: [],
  active: [],
  sessions: [],
  tasks: [],
  taskModels: [],
  summaries: [],
  limits: null,
  ...over,
});

describe('buildReport agregatsiyasi', () => {
  it('jami, loyiha, limit ulushi, model aralashmasi, narx', () => {
    const r = buildReport(
      base({
        models: [
          model({ projectId: P1, model: 'claude-opus-4-7', input: 1000, output: 1000, cost: 2 }), // vaznli 1000 + 5000 = 6000
          model({ projectId: P1, model: 'claude-sonnet-5-5', input: 2000, output: 0, cost: 1 }), // 2000
          model({ projectId: P2, model: 'claude-sonnet-5-5', input: 2000, output: 0, cost: null }), // 2000
          model({ projectId: null, model: 'claude-haiku-4-5', input: 0, output: 0, cacheRead: 10_000, cost: null }), // 1000 (noma'lum loyiha)
        ],
        closed: [{ projectId: P1, key: '3.2', title: 'Watchdog' }],
        commits: [{ projectId: P1, count: 4 }, { projectId: P2, count: 1 }],
        active: [{ projectId: P1, seconds: 3600 }, { projectId: P2, seconds: 600 }, { projectId: null, seconds: 60 }],
        sessions: [{ projectId: P1, sessions: 2 }, { projectId: P2, sessions: 1 }],
      }),
    );
    expect(r.total.tokens.weighted).toBe(11_000);
    expect(r.total.costUsd).toBe(3);
    expect(r.total.commits).toBe(5);
    expect(r.total.sessions).toBe(3);
    expect(r.total.activeSeconds).toBe(4260);
    expect(r.total.models.map((m) => [m.model, m.share])).toEqual([['Opus', 0.545], ['Sonnet', 0.364], ['Haiku', 0.091]]);
    expect(r.projects.map((p) => p.name)).toEqual(['commander', 'iot']); // sarf bo'yicha
    const c = r.projects[0]!;
    expect(c).toMatchObject({ tasksClosed: [{ key: '3.2', title: 'Watchdog' }], commits: 4, costUsd: 3, sessions: 2 });
    expect(c.limitShare).toBe(0.727); // 8000/11000
    expect(r.projects[1]!.costUsd).toBeNull();
    expect(r.projects[1]!.limitShare).toBe(0.182);
  });

  it('top vazifalar (eng ko\'p sarf, 3 ta) va reja-haqiqiy faqat rejali vazifalar bo\'yicha', () => {
    const tasks: TaskStatRow[] = [
      { projectId: P1, key: 'a', title: 'A', plannedHours: 2, weighted: 100, cost: 1, activeSeconds: 7200 },
      { projectId: P1, key: 'b', title: null, plannedHours: null, weighted: 900, cost: null, activeSeconds: 3600 },
      { projectId: P1, key: 'c', title: 'C', plannedHours: 6, weighted: 500, cost: 2, activeSeconds: 1800 },
      { projectId: P1, key: 'd', title: 'D', plannedHours: null, weighted: 300, cost: null, activeSeconds: 0 },
      { projectId: P1, key: 'e', title: 'E', plannedHours: null, weighted: 0, cost: null, activeSeconds: 60 },
    ];
    const r = buildReport(base({ models: [model({})], tasks }));
    const p = r.projects[0]!;
    expect(p.topTasks.map((t) => t.key)).toEqual(['b', 'c', 'd']);
    expect(p.planVsActual).toEqual({ plannedHours: 8, actualHours: 2.5, tasks: 2 });
  });

  it('faoliyat yo\'q: bo\'sh hisobot, bo\'sh loyihalar', () => {
    const r = buildReport(base());
    expect(r.projects).toEqual([]);
    expect(r.total.tokens.weighted).toBe(0);
    expect(r.total.limitShare).toBe(0);
    expect(r.recommendations).toEqual([]);
  });

  it('kunlik xulosalar sanasi bo\'yicha tartiblanadi', () => {
    const r = buildReport(base({ models: [model({})], summaries: [{ projectId: P1, day: '2026-11-12', summary: 'ikkinchi' }, { projectId: P1, day: '2026-11-11', summary: 'birinchi' }] }));
    expect(r.projects[0]!.summaries).toEqual(['birinchi', 'ikkinchi']);
  });

  it('modelFamily', () => {
    expect(modelFamily('claude-opus-4-7[1m]')).toBe('Opus');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('Haiku');
    expect(modelFamily('gpt-x')).toBe('gpt-x');
  });
});

describe('tavsiya evristikasi', () => {
  const names = new Map([[P1, 'commander']]);
  const task = (over: Partial<TaskStatRow> = {}): TaskStatRow => ({ projectId: P1, key: '3.4', title: null, plannedHours: 2, weighted: 400_000, cost: null, activeSeconds: 100, ...over });
  const tm = (m: string, w: number): TaskModelRow => ({ projectId: P1, key: '3.4', model: m, weighted: w, output: 100, requests: 5 });

  it('R1: kichik vazifa, Opus ulushi >= 60% va >= 200k -> Sonnet', () => {
    const r = recommend({ models: [], tasks: [task()], taskModels: [tm('claude-opus-4-7', 300_000), tm('claude-sonnet-5-5', 100_000)] }, names);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('«3.4»');
    expect(r[0]).toContain('75% Opus');
  });

  it('R1 ishlamaydi: katta vazifa, kam sarf, Opus ulushi past, reja yo\'q', () => {
    const rows = [tm('claude-opus-4-7', 300_000), tm('claude-sonnet-5-5', 100_000)];
    expect(recommend({ models: [], tasks: [task({ plannedHours: 6 })], taskModels: rows }, names)).toEqual([]);
    expect(recommend({ models: [], tasks: [task({ plannedHours: null })], taskModels: rows }, names)).toEqual([]);
    expect(recommend({ models: [], tasks: [task()], taskModels: [tm('claude-opus-4-7', 100_000)] }, names)).toEqual([]);
    expect(recommend({ models: [], tasks: [task()], taskModels: [tm('claude-opus-4-7', 100_000), tm('claude-sonnet-5-5', 300_000)] }, names)).toEqual([]);
  });

  it('R2: Opus >= 20 so\'rov, o\'rtacha chiqish < 400, ulush >= 50%', () => {
    const opus = model({ model: 'claude-opus-4-7', requests: 30, output: 30 * 200, input: 100_000 });
    const sonnet = model({ model: 'claude-sonnet-5-5', requests: 5, input: 1000, output: 100 });
    const r = recommend({ models: [opus, sonnet], tasks: [], taskModels: [] }, names);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('commander');
    expect(r[0]).toContain('o\'rtacha 200');
    // uzun chiqish yoki kam so'rov: tavsiya yo'q
    expect(recommend({ models: [{ ...opus, output: 30 * 900 }], tasks: [], taskModels: [] }, names)).toEqual([]);
    expect(recommend({ models: [{ ...opus, requests: 10 }], tasks: [], taskModels: [] }, names)).toEqual([]);
  });

  it('eng ko\'pi bilan 5 ta', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task({ key: `k${i}` }));
    const taskModels = tasks.map((t) => ({ ...tm('claude-opus-4-7', 400_000), key: t.key }));
    expect(recommend({ models: [], tasks, taskModels }, names)).toHaveLength(5);
  });
});
