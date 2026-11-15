import { describe, expect, it } from 'vitest';
import { buildTimesheet, monthRange, periodDays, taskId, UNASSIGNED_CLIENT_NAME } from './timesheet-logic.js';
import type { TimesheetInput } from './timesheet-logic.js';
import { tashkentDayRange } from '../projects/tashkent-day.js';

const H = 3_600_000;
const FROM = '2026-11-01';
const TO = '2026-11-30';
const start = tashkentDayRange(FROM).start.getTime();
const end = tashkentDayRange(TO).end.getTime();
const at = (h: number): number => start + h * H;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const T = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function base(over: Partial<TimesheetInput> = {}): TimesheetInput {
  return {
    from: FROM,
    to: TO,
    startMs: start,
    endMs: end,
    nowMs: NOW,
    projectNames: new Map([['github.com/o/a', 'alpha'], ['github.com/o/b', 'beta'], ['github.com/o/c', 'gamma']]),
    clients: [{ id: 'c1', name: 'Acme', hourlyRate: '10', currency: 'USD' }],
    mapping: new Map([['github.com/o/a', 'c1'], ['github.com/o/b', 'c1']]),
    events: [],
    spans: [],
    projectTokens: new Map(),
    taskTokens: new Map(),
    closed: [],
    projectCommits: new Map(),
    taskCommits: new Map(),
    taskInfo: new Map(),
    sizeHours: () => null,
    currency: null,
    fxUzsPerUsd: null,
    ...over,
  };
}
const ev = (s: string, key: string | null, h: number, status: string, nextH: number | null) => ({ sessionId: s, projectKey: key, ts: at(h), status, nextTs: nextH === null ? null : at(h + nextH) });

describe('buildTimesheet', () => {
  it("mijoz jami = loyihalar birlashmasi (parallel ishlash ikki marta sanalmaydi)", () => {
    const dto = buildTimesheet(
      base({
        events: [ev('s1', 'github.com/o/a', 1, 'working', 2), ev('s2', 'github.com/o/b', 2, 'working', 2)], // s1: 1..3, s2: 2..4
      }),
    );
    const c = dto.clients[0]!;
    expect(c.projects.map((p) => p.totals.activeSeconds).sort()).toEqual([7200, 7200]);
    expect(c.totals.activeSeconds).toBe(3 * 3600);
    expect(c.overlapSeconds).toBe(3600);
    expect(c.totals.sessions).toBe(2);
    expect(dto.total.activeSeconds).toBe(3 * 3600);
  });

  it("summa: daqiqaga yaxlitlangan soat x stavka", () => {
    const dto = buildTimesheet(base({ events: [ev('s1', 'github.com/o/a', 1, 'working', 1.5)] }));
    const c = dto.clients[0]!;
    expect(c.billedMinutes).toBe(90);
    expect(c.amount).toBe('15.00');
    expect(c.amountCurrency).toBe('USD');
  });

  it("valyuta farq qilsa kurs kerak; kurs bilan UZS'ga o'giriladi", () => {
    const events = [ev('s1', 'github.com/o/a', 1, 'working', 1.5)];
    const noFx = buildTimesheet(base({ events, currency: 'UZS' })).clients[0]!;
    expect(noFx.amount).toBeNull();
    expect(noFx.amountNote).toMatch(/Kurs/);
    const withFx = buildTimesheet(base({ events, currency: 'UZS', fxUzsPerUsd: '12600' })).clients[0]!;
    expect(withFx.amount).toBe('189000');
    expect(withFx.amountCurrency).toBe('UZS');
  });

  it("stavka yo'q -> summa yo'q, izoh bor", () => {
    const dto = buildTimesheet(base({ clients: [{ id: 'c1', name: 'Acme', hourlyRate: null, currency: 'UZS' }], events: [ev('s1', 'github.com/o/a', 1, 'working', 1)] }));
    expect(dto.clients[0]!.amount).toBeNull();
    expect(dto.clients[0]!.amountNote).toMatch(/stavka/i);
    expect(dto.clients[0]!.rateCurrency).toBeNull();
  });

  it("biriktirilmagan loyiha alohida blok; noma'lum cwd ham", () => {
    const dto = buildTimesheet(base({ events: [ev('s1', 'github.com/o/c', 1, 'working', 1), ev('s2', null, 5, 'working', 1)] }));
    const un = dto.clients.find((c) => c.clientId === null)!;
    expect(un.name).toBe(UNASSIGNED_CLIENT_NAME);
    expect(un.projects.map((p) => p.name).sort()).toEqual(["Noma'lum (cwd yo'q)", 'gamma']);
    expect(un.amount).toBeNull();
    expect(dto.clients.find((c) => c.clientId === 'c1')).toBeUndefined();
  });

  it("vazifalar: span ∩ faol oraliq, vazifasiz qism alohida, reja vs haqiqiy", () => {
    const key = 'github.com/o/a';
    const dto = buildTimesheet(
      base({
        events: [ev('s1', key, 1, 'working', 4)], // 1..5 soat
        spans: [{ sessionId: 's1', projectKey: key, taskKey: '6.7', startMs: at(2), endMs: at(4) }], // 2 soat
        taskTokens: new Map([[taskId(key, '6.7'), { tokens: { ...T, input: 100, output: 50 }, costUsd: 1.5, sessions: 1 }]]),
        taskInfo: new Map([[taskId(key, '6.7'), { title: 'Timesheet', status: 'doing' as const, size: 'S' }]]),
        sizeHours: (s) => (s === 'S' ? 2 : null),
        closed: [{ projectKey: key, taskKey: '6.7' }],
        taskCommits: new Map([[taskId(key, '6.7'), 3]]),
        projectCommits: new Map([[key, 4]]),
      }),
    );
    const p = dto.clients[0]!.projects[0]!;
    expect(p.totals.activeSeconds).toBe(4 * 3600);
    expect(p.unattributedSeconds).toBe(2 * 3600);
    const t = p.tasks[0]!;
    expect(t).toMatchObject({ key: '6.7', title: 'Timesheet', activeSeconds: 7200, commits: 3, closedInPeriod: true, plannedHours: 2, costUsd: 1.5 });
    expect(p.totals.plannedSeconds).toBe(7200);
    expect(p.totals.plannedActualSeconds).toBe(7200);
    expect(p.totals.tasksClosed).toBe(1);
    expect(p.totals.commits).toBe(4);
  });

  it("bir sessiyada ikki ketma-ket span, span oyna ochiq (ended null) = now/oyna oxirigacha", () => {
    const key = 'github.com/o/a';
    const dto = buildTimesheet(
      base({
        events: [ev('s1', key, 1, 'working', 3)],
        spans: [
          { sessionId: 's1', projectKey: key, taskKey: 'a', startMs: at(0), endMs: at(2) },
          { sessionId: 's1', projectKey: key, taskKey: 'b', startMs: at(2), endMs: null },
        ],
      }),
    );
    const tasks = dto.clients[0]!.projects[0]!.tasks;
    expect(tasks.map((t) => [t.key, t.activeSeconds]).sort()).toEqual([['a', 3600], ['b', 7200]]);
    expect(dto.clients[0]!.projects[0]!.unattributedSeconds).toBe(0);
  });

  it("davr o'rtasida boshlanib oy chegarasidan o'tgan sessiya kesiladi", () => {
    const key = 'github.com/o/a';
    // oxirgi kun oxiridan 1 soat oldin boshlanib 3 soat davom etgan
    const dto = buildTimesheet(base({ events: [{ sessionId: 's1', projectKey: key, ts: end - H, status: 'working', nextTs: end + 2 * H }] }));
    expect(dto.total.activeSeconds).toBe(3600);
  });

  it("30 kundan uzoq davr: loyiha tokenlari agregatdan to'liq, vazifa tokenlari 'to'liq emas' belgisi", () => {
    const key = 'github.com/o/a';
    const dto = buildTimesheet(
      base({
        nowMs: Date.parse('2027-01-15T00:00:00Z'),
        events: [ev('s1', key, 1, 'working', 1)],
        projectTokens: new Map([[key, { tokens: { ...T, input: 9_000_000, output: 1_000_000 }, costUsd: 123.4567891 }]]),
      }),
    );
    expect(dto.taskTokensPartial).toBe(true);
    expect(dto.activeTimePartial).toBe(false);
    const p = dto.clients[0]!.projects[0]!;
    expect(p.totals.tokens.input).toBe(9_000_000);
    expect(p.totals.costUsd).toBe(123.456789);
    expect(dto.total.tokens.output).toBe(1_000_000);
    const old = buildTimesheet(base({ nowMs: Date.parse('2027-06-01T00:00:00Z') }));
    expect(old.activeTimePartial).toBe(true);
  });

  it("joriy oy: belgilar o'chiq", () => {
    expect(buildTimesheet(base({ nowMs: Date.parse('2026-11-20T00:00:00Z') })).taskTokensPartial).toBe(false);
  });

  it("faqat token (faol vaqt yo'q) bo'lgan loyiha ham ko'rinadi; to'liq bo'sh ko'rinmaydi", () => {
    const key = 'github.com/o/a';
    const dto = buildTimesheet(base({ projectTokens: new Map([[key, { tokens: { ...T, input: 5 }, costUsd: null }]]) }));
    expect(dto.clients[0]!.projects).toHaveLength(1);
    expect(dto.clients[0]!.projects[0]!.totals.costUsd).toBeNull();
    expect(buildTimesheet(base()).clients).toEqual([]);
  });

  it('awaiting_approval ham faol', () => {
    const dto = buildTimesheet(base({ events: [ev('s1', 'github.com/o/a', 1, 'awaiting_approval', 1)] }));
    expect(dto.total.activeSeconds).toBe(3600);
  });
});

describe('monthRange / periodDays', () => {
  it('oy chegaralari (kabisa yil)', () => {
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('kunlar soni', () => {
    expect(periodDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(periodDays('2026-11-01', '2026-11-30')).toBe(30);
  });
});
