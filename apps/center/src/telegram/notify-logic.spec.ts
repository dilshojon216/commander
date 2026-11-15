import { describe, expect, it } from 'vitest';
import type { LimitWindowView, LimitsResponse } from '@commander/contracts';
import { DONE_NOTICE_DELAY_MS, DoneNoticeScheduler, MachineWatch, SessionNoticeGate, decideLimitAlerts, type TimerScheduler } from './notify-logic.js';

const view = (over: Partial<LimitWindowView>): LimitWindowView => ({
  usedPct: 0,
  resetsAt: '2026-11-13T15:00:00.000Z',
  observedAt: '2026-11-13T12:00:00.000Z',
  source: 'official',
  stale: false,
  ageSeconds: 5,
  reset: false,
  calibration: { coefficient: null, samples: 0 },
  ...over,
} as LimitWindowView);

const limits = (five: Partial<LimitWindowView> | null, seven: Partial<LimitWindowView> | null = null): LimitsResponse => ({
  computedAt: '2026-11-13T12:00:00.000Z',
  freshSeconds: 180,
  fiveHour: five ? view(five) : null,
  sevenDay: seven ? view({ resetsAt: '2026-11-18T00:00:00.000Z', ...seven }) : null,
});

describe('decideLimitAlerts', () => {
  it('80% da bir marta, takroriy kuzatuvda jim', () => {
    const a = decideLimitAlerts(limits({ usedPct: 81 }), {});
    expect(a.alerts.map((x) => [x.window, x.threshold])).toEqual([['fiveHour', 80]]);
    expect(decideLimitAlerts(limits({ usedPct: 84 }), a.state).alerts).toEqual([]);
  });
  it('80 keyin 95: ikkinchi ogohlantirish; bir vaqtda ikkalasi kesilsa faqat 95', () => {
    const first = decideLimitAlerts(limits({ usedPct: 82 }), {});
    const second = decideLimitAlerts(limits({ usedPct: 96 }), first.state);
    expect(second.alerts.map((x) => x.threshold)).toEqual([95]);
    const jump = decideLimitAlerts(limits({ usedPct: 97 }), {});
    expect(jump.alerts.map((x) => x.threshold)).toEqual([95]);
    expect(decideLimitAlerts(limits({ usedPct: 97 }), jump.state).alerts).toEqual([]); // 80 ham belgilangan
  });
  it('yangi oyna (resetsAt boshqa) qayta ogohlantiradi; soniyalik siljish yangi oyna emas', () => {
    const first = decideLimitAlerts(limits({ usedPct: 85 }), {});
    expect(decideLimitAlerts(limits({ usedPct: 85, resetsAt: '2026-11-13T15:00:07.000Z' }), first.state).alerts).toEqual([]);
    expect(decideLimitAlerts(limits({ usedPct: 85, resetsAt: '2026-11-13T20:00:00.000Z' }), first.state).alerts).toHaveLength(1);
  });
  it('haftalik: 90% dan, 80% da emas', () => {
    expect(decideLimitAlerts(limits(null, { usedPct: 85 }), {}).alerts).toEqual([]);
    expect(decideLimitAlerts(limits(null, { usedPct: 91 }), {}).alerts.map((x) => [x.window, x.threshold])).toEqual([['sevenDay', 90]]);
  });
  it('taxmin (estimate) hech qachon trigger qilmaydi; resetsAt yo\'q ham', () => {
    expect(decideLimitAlerts(limits({ usedPct: 99, source: 'estimate' }), {}).alerts).toEqual([]);
    expect(decideLimitAlerts(limits({ usedPct: 99, resetsAt: null }), {}).alerts).toEqual([]);
  });
});

describe('SessionNoticeGate', () => {
  const ctx = { notifyDone: true, mutedUntil: 0 };
  it('birinchi ko\'rilgan holat jim; keyin working -> waiting xabar beradi', () => {
    const g = new SessionNoticeGate(60_000);
    expect(g.observe('s1', 'waiting')).toBeNull();
    expect(g.observe('s1', 'working')).toBeNull();
    expect(g.observe('s1', 'waiting')).toBe('waiting');
    expect(g.admit('s1', 'waiting', 1_000, ctx)).toBe(true);
  });
  it('bir xil holat takrori (dublikat hodisa) nomzod emas', () => {
    const g = new SessionNoticeGate();
    g.seed('s1', 'working');
    expect(g.observe('s1', 'waiting')).toBe('waiting');
    expect(g.observe('s1', 'waiting')).toBeNull();
  });
  it('seed mavjud holatni bosmaydi', () => {
    const g = new SessionNoticeGate();
    g.observe('s1', 'working');
    g.seed('s1', 'waiting');
    expect(g.observe('s1', 'waiting')).toBe('waiting');
  });
  it('sessiya bo\'yicha 60 s oralig\'i', () => {
    const g = new SessionNoticeGate(60_000);
    g.seed('s1', 'working');
    expect(g.observe('s1', 'waiting')).toBe('waiting');
    expect(g.admit('s1', 'waiting', 10_000, ctx)).toBe(true);
    g.observe('s1', 'working');
    expect(g.observe('s1', 'done')).toBe('done');
    expect(g.admit('s1', 'done', 40_000, ctx)).toBe(false); // 30 s
    g.observe('s1', 'working');
    g.observe('s1', 'waiting');
    expect(g.admit('s1', 'waiting', 71_000, ctx)).toBe(true); // 61 s
  });
  it('mute va notify done', () => {
    const g = new SessionNoticeGate();
    g.seed('s1', 'working');
    g.observe('s1', 'done');
    expect(g.admit('s1', 'done', 5_000, { notifyDone: false, mutedUntil: 0 })).toBe(false);
    expect(g.admit('s1', 'done', 5_000, { notifyDone: true, mutedUntil: 10_000 })).toBe(false);
    expect(g.admit('s1', 'done', 11_000, { notifyDone: true, mutedUntil: 10_000 })).toBe(true);
  });
  it('waiting/done bo\'lmagan o\'tishlar nomzod emas', () => {
    const g = new SessionNoticeGate();
    g.seed('s1', 'waiting');
    expect(g.observe('s1', 'working')).toBeNull();
    expect(g.observe('s1', 'awaiting_approval')).toBeNull();
  });
});

describe('MachineWatch', () => {
  const T0 = 1_000_000;
  it('2 daqiqadan keyin bir marta ogohlantiradi, qaytganda bir marta xabar', () => {
    const w = new MachineWatch(T0 - 10 * 60_000);
    w.observe('m1', true, T0);
    w.observe('m1', false, T0 + 1000);
    expect(w.due(T0 + 60_000)).toEqual([]);
    expect(w.due(T0 + 1000 + 120_000)).toEqual(['m1']);
    expect(w.due(T0 + 600_000)).toEqual([]); // takror yo'q
    expect(w.observe('m1', true, T0 + 700_000)).toBe('back_online');
    expect(w.observe('m1', true, T0 + 800_000)).toBeNull();
  });
  it('2 daqiqadan oldin qaytsa: ogohlantirish ham, "qaytdi" ham yo\'q', () => {
    const w = new MachineWatch(T0 - 10 * 60_000);
    w.observe('m1', true, T0);
    w.observe('m1', false, T0 + 1000);
    expect(w.observe('m1', true, T0 + 30_000)).toBeNull();
    expect(w.due(T0 + 500_000)).toEqual([]);
  });
  it('markaz ishga tushishidagi offline (grace va boshlang\'ich) jim', () => {
    const w = new MachineWatch(T0, 90_000);
    w.observe('boot-offline', false, T0 + 1); // boshlang'ich offline
    w.observe('flap', true, T0 + 1);
    w.observe('flap', false, T0 + 5_000); // grace ichida
    expect(w.due(T0 + 600_000)).toEqual([]);
    expect(w.observe('flap', true, T0 + 20_000)).toBeNull();
    expect(w.observe('boot-offline', true, T0 + 30_000)).toBeNull();
  });
});

describe('DoneNoticeScheduler', () => {
  const fake = () => {
    let now = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const scheduler: TimerScheduler = {
      set: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (h) => void timers.delete(h as number),
    };
    const advance = (ms: number): void => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    };
    return { scheduler, advance };
  };

  it('kechikishdan keyin bir marta ishga tushadi', () => {
    const f = fake();
    const d = new DoneNoticeScheduler(DONE_NOTICE_DELAY_MS, f.scheduler);
    const fire = vi.fn();
    d.schedule('s1', fire);
    f.advance(DONE_NOTICE_DELAY_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    f.advance(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(d.size).toBe(0);
  });
  it('yangi done eskisini almashtiradi (sessiya bo\'yicha bitta)', () => {
    const f = fake();
    const d = new DoneNoticeScheduler(1000, f.scheduler);
    const a = vi.fn();
    const b = vi.fn();
    d.schedule('s1', a);
    f.advance(600);
    d.schedule('s1', b);
    expect(d.size).toBe(1);
    f.advance(600);
    expect(a).not.toHaveBeenCalled();
    f.advance(400);
    expect(b).toHaveBeenCalledTimes(1);
  });
  it('cancel va clearAll kutilayotganlarni o\'chiradi', () => {
    const f = fake();
    const d = new DoneNoticeScheduler(1000, f.scheduler);
    const a = vi.fn();
    const b = vi.fn();
    d.schedule('s1', a);
    d.schedule('s2', b);
    d.cancel('s1');
    d.cancel('yo\'q');
    expect(d.size).toBe(1);
    d.clearAll();
    f.advance(5000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(d.size).toBe(0);
  });
});
