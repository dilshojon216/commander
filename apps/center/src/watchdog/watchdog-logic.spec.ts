import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCHDOG_SETTINGS } from '@commander/contracts';
import type { WatchdogSettings } from '@commander/contracts';
import { burnPct, describeAlert, evaluate, reminderDue, resolveThresholds, waitingEpisodeKey } from './watchdog-logic.js';
import type { Action, EvalInput, OpenAlertRow, SessionSnap } from './watchdog-logic.js';

const T0 = Date.parse('2026-11-13T10:00:00Z');
const at = (min: number): Date => new Date(T0 + min * 60_000);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';

const session = (over: Partial<SessionSnap> = {}): SessionSnap => ({ id: S1, machineId: 'm1', projectId: P1, status: 'waiting', statusSince: at(0), endedAt: null, staleSince: null, ...over });
const input = (over: Partial<EvalInput> = {}): EvalInput => ({
  now: at(0),
  settings: DEFAULT_WATCHDOG_SETTINGS,
  sessions: [session()],
  burn: [],
  errors: [],
  fiveHourCoefficient: null,
  open: [],
  history: [],
  ...over,
});
const settings = (over: Partial<WatchdogSettings> = {}): WatchdogSettings => ({ ...DEFAULT_WATCHDOG_SETTINGS, ...over });
const kinds = (a: Action[]): string[] => a.map((x) => (x.type === 'create' ? `create:${x.kind}` : x.type));

describe('waiting', () => {
  it('14 daqiqada jim, 15 daqiqada bitta ogohlantirish (vaqt sayohati)', () => {
    expect(evaluate(input({ now: at(14) }))).toEqual([]);
    const a = evaluate(input({ now: at(15) }));
    expect(kinds(a)).toEqual(['create:waiting']);
    expect(a[0]).toMatchObject({ episodeKey: waitingEpisodeKey(at(0)), metrics: { minutes: 15, status: 'waiting' } });
  });

  it('awaiting_approval ham sanaladi; working/idle/done sanalmaydi', () => {
    expect(kinds(evaluate(input({ now: at(30), sessions: [session({ status: 'awaiting_approval' })] })))).toEqual(['create:waiting']);
    for (const status of ['working', 'idle', 'done'] as const) expect(evaluate(input({ now: at(60), sessions: [session({ status })] }))).toEqual([]);
  });

  it('ochiq ogohlantirish bor: qayta yaratilmaydi; eslatma 1 soatdan keyin, ko\'pi bilan 3 ta', () => {
    const open: OpenAlertRow = { id: 'a1', kind: 'waiting', sessionId: S1, episodeKey: waitingEpisodeKey(at(0)), createdAt: at(15), lastNotifiedAt: at(15), remindersSent: 0, metrics: {} };
    expect(evaluate(input({ now: at(40), open: [open] }))).toEqual([]);
    expect(kinds(evaluate(input({ now: at(75), open: [open] })))).toEqual(['remind']);
    expect(reminderDue({ ...open, remindersSent: 3 }, at(600))).toBe(false);
    expect(reminderDue({ ...open, remindersSent: 2, lastNotifiedAt: at(75) }, at(135))).toBe(true);
    expect(reminderDue({ ...open, remindersSent: 2, lastNotifiedAt: at(75) }, at(134))).toBe(false);
  });

  it('holat o\'zgarsa ogohlantirish yopiladi (recovered), sessiya tugasa (ended)', () => {
    const open: OpenAlertRow = { id: 'a1', kind: 'waiting', sessionId: S1, episodeKey: waitingEpisodeKey(at(0)), createdAt: at(15), lastNotifiedAt: at(15), remindersSent: 0, metrics: {} };
    const a = evaluate(input({ now: at(20), open: [open], sessions: [session({ status: 'working', statusSince: at(18) })] }));
    expect(a).toEqual([{ type: 'resolve', alert: open, reason: 'recovered' }]);
    const b = evaluate(input({ now: at(20), open: [open], sessions: [session({ status: 'ended', endedAt: at(19) })] }));
    expect(b).toEqual([{ type: 'resolve', alert: open, reason: 'ended' }]);
    // boshqa epizod (waiting -> working -> waiting): eskisi yopiladi, yangisi 15 daqiqadan keyin
    const c = evaluate(input({ now: at(25), open: [open], sessions: [session({ statusSince: at(20) })] }));
    expect(kinds(c)).toEqual(['resolve']);
  });

  it('bo\'ron to\'sig\'i: rad etilgan/yopilgan epizod qayta ochilmaydi; yangi epizod ochiladi', () => {
    const hist = [{ sessionId: S1, kind: 'waiting' as const, episodeKey: waitingEpisodeKey(at(0)), createdAt: at(15) }];
    expect(evaluate(input({ now: at(200), history: hist }))).toEqual([]);
    expect(kinds(evaluate(input({ now: at(230), history: hist, sessions: [session({ statusSince: at(200) })] })))).toEqual(['create:waiting']);
  });

  it('offline (stale) mashinadagi sessiya uchun yangi ogohlantirish yo\'q', () => {
    expect(evaluate(input({ now: at(60), sessions: [session({ staleSince: at(10) })] }))).toEqual([]);
  });
});

describe('burn (ortiqcha sarf)', () => {
  const burnIn = (w: number, over: Partial<EvalInput> = {}): EvalInput => input({ sessions: [session({ status: 'working' })], burn: [{ sessionId: S1, weighted10m: w }], ...over });

  it('5M vaznli token chegarasi: 4.99M jim, 5M ogohlantirish', () => {
    expect(evaluate(burnIn(4_999_999))).toEqual([]);
    const a = evaluate(burnIn(5_000_000));
    expect(kinds(a)).toEqual(['create:burn']);
    expect(a[0]).toMatchObject({ autoStop: false, metrics: { weighted10m: 5_000_000, pct10m: null } });
  });

  it('5 soatlik oynaning X% qoidasi: koeffitsient * vaznli', () => {
    // 1M * 1e-5 = 10% -> chegara 10
    expect(burnPct(1_000_000, 1e-5)).toBe(10);
    expect(burnPct(1_000_000, null)).toBeNull();
    expect(kinds(evaluate(burnIn(1_000_000, { fiveHourCoefficient: 1e-5 })))).toEqual(['create:burn']);
    expect(evaluate(burnIn(900_000, { fiveHourCoefficient: 1e-5 }))).toEqual([]);
    expect(evaluate(burnIn(1_000_000, { fiveHourCoefficient: null }))).toEqual([]);
  });

  it('sozlanadigan chegara va loyiha/sessiya qayta belgilashi (sessiya loyihadan ustun)', () => {
    const s = settings({ projects: { [P1]: { burnWeightedTokens: 1_000_000, autoStop: true } }, sessions: { [S1]: { burnWeightedTokens: 2_000_000 } } });
    expect(resolveThresholds(s, P1, S1)).toMatchObject({ burnWeightedTokens: 2_000_000, autoStop: true, waitingMinutes: 15 });
    expect(evaluate(burnIn(1_500_000, { settings: s }))).toEqual([]);
    const a = evaluate(burnIn(2_000_000, { settings: s }));
    expect(a[0]).toMatchObject({ type: 'create', kind: 'burn', autoStop: true });
  });

  it('gisterezis: chegaraning yarmidan pastga tushganda yopiladi, oraliqda ochiq qoladi; 25% o\'sganda yangilanadi', () => {
    const open: OpenAlertRow = { id: 'b1', kind: 'burn', sessionId: S1, episodeKey: '', createdAt: at(0), lastNotifiedAt: at(0), remindersSent: 0, metrics: { weighted10m: 5_000_000 } };
    expect(evaluate(burnIn(3_000_000, { open: [open] }))).toEqual([]);
    expect(kinds(evaluate(burnIn(2_000_000, { open: [open] })))).toEqual(['resolve']);
    expect(kinds(evaluate(burnIn(6_500_000, { open: [open] })))).toEqual(['update']);
  });

  it('sovish: yopilgandan keyin 30 daqiqa ichida yangisi yaratilmaydi', () => {
    const hist = [{ sessionId: S1, kind: 'burn' as const, episodeKey: '', createdAt: at(0) }];
    expect(evaluate(burnIn(9_000_000, { now: at(29), history: hist }))).toEqual([]);
    expect(kinds(evaluate(burnIn(9_000_000, { now: at(31), history: hist })))).toEqual(['create:burn']);
  });

  it('o\'chirilgan watchdog: yangi yo\'q, ochiqlar yopiladi', () => {
    const open: OpenAlertRow = { id: 'b1', kind: 'burn', sessionId: S1, episodeKey: '', createdAt: at(0), lastNotifiedAt: null, remindersSent: 0, metrics: {} };
    const a = evaluate(burnIn(9_000_000, { settings: settings({ enabled: false }), open: [open] }));
    expect(a).toEqual([{ type: 'resolve', alert: open, reason: 'disabled' }]);
  });
});

describe('error_loop', () => {
  const errIn = (count: number, hash = 'abcdef012345', over: Partial<EvalInput> = {}): EvalInput =>
    input({ sessions: [session({ status: 'working' })], errors: [{ sessionId: S1, hash, count }], ...over });

  it('>= 5 takror: ogohlantirish; 4 jim', () => {
    expect(evaluate(errIn(4))).toEqual([]);
    const a = evaluate(errIn(5));
    expect(a[0]).toMatchObject({ type: 'create', kind: 'error_loop', episodeKey: 'abcdef012345', autoStop: false, metrics: { count: 5 } });
  });

  it('chegara sozlanadi; auto-stop yoqilgan loyihada autoStop=true', () => {
    const s = settings({ defaults: { ...DEFAULT_WATCHDOG_SETTINGS.defaults, errorLoopCount: 8 }, projects: { [P1]: { autoStop: true } } });
    expect(evaluate(errIn(7, 'abcdef012345', { settings: s }))).toEqual([]);
    expect(evaluate(errIn(8, 'abcdef012345', { settings: s }))[0]).toMatchObject({ autoStop: true });
  });

  it('boshqa xato xeshi bo\'lsa sovish to\'smaydi; xuddi shu xesh sovish ichida to\'siladi', () => {
    const hist = [{ sessionId: S1, kind: 'error_loop' as const, episodeKey: 'abcdef012345', createdAt: at(-10) }];
    expect(evaluate(errIn(9, 'abcdef012345', { history: hist }))).toEqual([]);
    expect(kinds(evaluate(errIn(9, '0123456789ab', { history: hist })))).toEqual(['create:error_loop']);
  });

  it('xato to\'xtasa (oynadan chiqdi) yopiladi', () => {
    const open: OpenAlertRow = { id: 'e1', kind: 'error_loop', sessionId: S1, episodeKey: 'abcdef012345', createdAt: at(0), lastNotifiedAt: at(0), remindersSent: 0, metrics: { count: 5 } };
    expect(kinds(evaluate(input({ sessions: [session({ status: 'working' })], open: [open] })))).toEqual(['resolve']);
  });

  it('bir nechta sessiya mustaqil', () => {
    const a = evaluate(
      input({
        sessions: [session({ id: S1, status: 'working' }), session({ id: S2, status: 'working', projectId: null })],
        errors: [
          { sessionId: S1, hash: 'abcdef012345', count: 5 },
          { sessionId: S2, hash: 'abcdef012345', count: 3 },
        ],
      }),
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'error_loop', session: { id: S1 } });
  });
});

describe('describeAlert', () => {
  it('matn faqat raqamlardan iborat, xesh qisqartiriladi', () => {
    expect(describeAlert('waiting', { minutes: 22, status: 'awaiting_approval' }).title).toBe('Ruxsat kutilmoqda');
    expect(describeAlert('burn', { weighted10m: 5_200_000, pct10m: 12.5 }).detail).toContain('5.2M');
    expect(describeAlert('error_loop', { count: 6, hash: 'abcdef012345' }).detail).toContain('abcdef01');
    expect(describeAlert('error_loop', { count: 6, hash: 'abcdef012345' }).detail).not.toContain('abcdef012345');
  });
});
