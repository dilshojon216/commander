import { describe, expect, it } from 'vitest';
import { AgentHealthPayloadSchema, DEFAULT_HEALTH_THRESHOLDS } from '@commander/contracts';
import type { AgentHealthPayload, HealthSnapshot, HealthThresholds } from '@commander/contracts';
import { computeStatus, exitCodeOf, isBadContainer, keyNumbers, mergeSnapshot, worstStatus } from './health-merge.js';
import { MachineConditionTracker, conditionKey } from './health-rules.js';
import type { Condition } from './health-rules.js';
import { planIncidents } from './incident-state.js';
import { resolveThresholds } from './health-thresholds.service.js';

const MIN = 60_000;
const T: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS;

const snap = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  collectedAt: 0,
  platform: 'linux',
  cpu: { pct: 10, cores: 4 },
  memory: { totalBytes: 1000, usedBytes: 500, swapTotalBytes: 0, swapUsedBytes: 0 },
  uptimeSec: 1,
  disks: [{ mount: '/', totalBytes: 100, usedBytes: 50, pct: 50 }],
  topProcesses: { byCpu: [], byMem: [] },
  ...over,
});
const ctr = (name: string, state: string, status: string, restartCount = 0, health: 'none' | 'healthy' | 'unhealthy' | 'starting' = 'none') => ({ name, image: 'img', state, status, restartCount, health });

describe('mergeSnapshot', () => {
  const full: AgentHealthPayload = {
    kind: 'full', collectedAt: 1, platform: 'linux', cpu: { pct: 1, cores: 2 }, memory: snap().memory, uptimeSec: 5,
    disks: snap().disks, topProcesses: { byCpu: [{ name: 'a', cpuPct: 1, memPct: 1 }], byMem: [] },
    docker: { available: true, containers: [ctr('web', 'running', 'Up')] }, systemd: { failed: ['x.service'] },
  };
  it('full almashtiradi', () => {
    const m = mergeSnapshot(snap({ disks: [] }), full);
    expect(m.docker?.containers).toHaveLength(1);
    expect(m.systemd?.failed).toEqual(['x.service']);
  });
  it('delta faqat o\'zgargan bo\'limni almashtiradi, qolganini saqlaydi', () => {
    const prev = mergeSnapshot(null, full);
    const delta: AgentHealthPayload = { kind: 'delta', collectedAt: 2, platform: 'linux', cpu: { pct: 99, cores: 2 }, memory: snap().memory, uptimeSec: 6, docker: { available: true, containers: [] } };
    const m = mergeSnapshot(prev, delta);
    expect(m.cpu.pct).toBe(99);
    expect(m.docker?.containers).toEqual([]);
    expect(m.disks).toEqual(full.disks);
    expect(m.systemd?.failed).toEqual(['x.service']);
    expect(m.topProcesses.byCpu).toHaveLength(1);
  });
  it('bazasiz delta: yetishmaydigan bo\'limlar bo\'sh', () => {
    const m = mergeSnapshot(null, { kind: 'delta', collectedAt: 2, platform: 'linux', cpu: { pct: 1, cores: 1 }, memory: snap().memory, uptimeSec: 1 });
    expect(m.disks).toEqual([]);
    expect(m.docker).toBeUndefined();
  });
  it('schema: full disks/topProcesses talab qiladi', () => {
    const bad = { ...full, disks: undefined };
    expect(AgentHealthPayloadSchema.safeParse(bad).success).toBe(false);
    expect(AgentHealthPayloadSchema.safeParse(full).success).toBe(true);
  });
});

describe('keyNumbers / status', () => {
  it('eng to\'la disk va xotira foizi', () => {
    const k = keyNumbers(snap({ disks: [{ mount: '/', totalBytes: 1, usedBytes: 1, pct: 40 }, { mount: '/data', totalBytes: 1, usedBytes: 1, pct: 91.5 }] }));
    expect(k).toEqual({ cpu: 10, memPct: 50, diskMaxPct: 91.5, diskMaxMount: '/data' });
    expect(keyNumbers(snap({ disks: [] })).diskMaxPct).toBeNull();
  });
  it('computeStatus', () => {
    const base = { online: true, snapshotAt: 1000, now: 2000, openSeverities: [] as Array<'warn' | 'critical'> };
    expect(computeStatus(base)).toBe('ok');
    expect(computeStatus({ ...base, openSeverities: ['warn'] })).toBe('warn');
    expect(computeStatus({ ...base, openSeverities: ['warn', 'critical'] })).toBe('critical');
    expect(computeStatus({ ...base, online: false })).toBe('offline');
    expect(computeStatus({ ...base, snapshotAt: null })).toBe('unknown');
    expect(computeStatus({ ...base, now: 1000 + 4 * MIN })).toBe('unknown');
    expect(computeStatus({ ...base, online: false, openSeverities: ['critical'] })).toBe('critical');
  });
  it('worstStatus', () => {
    expect(worstStatus([])).toBe('unknown');
    expect(worstStatus(['ok', 'offline'])).toBe('offline');
    expect(worstStatus(['ok', 'warn', 'offline', 'critical'])).toBe('critical');
  });
  it('konteyner yomonligi: exit 0 yomon emas', () => {
    expect(exitCodeOf('Exited (137) 2 minutes ago')).toBe(137);
    expect(isBadContainer(ctr('a', 'exited', 'Exited (0) 1 hour ago'))).toBe(false);
    expect(isBadContainer(ctr('a', 'exited', 'Exited (1) 1 hour ago'))).toBe(true);
    expect(isBadContainer(ctr('a', 'running', 'Up (unhealthy)', 0, 'unhealthy'))).toBe(true);
    expect(isBadContainer(ctr('a', 'restarting', 'Restarting'))).toBe(true);
    expect(isBadContainer(ctr('a', 'running', 'Up', 0, 'healthy'))).toBe(false);
    expect(isBadContainer(ctr('a', 'paused', 'Up (Paused)'))).toBe(false);
  });
});

describe('MachineConditionTracker', () => {
  const none = new Map<string, 'warn' | 'critical'>();
  const diskOf = (pct: number): HealthSnapshot => snap({ disks: [{ mount: '/', totalBytes: 100, usedBytes: pct, pct }] });

  it('disk: 85 warn, 95 critical, 84 hech narsa', () => {
    const tr = new MachineConditionTracker();
    expect(tr.evaluate(diskOf(84), T, 0, none).conditions).toEqual([]);
    expect(tr.evaluate(diskOf(85), T, 0, none).conditions[0]).toMatchObject({ kind: 'disk', subject: '/', severity: 'warn' });
    expect(tr.evaluate(diskOf(95), T, 0, none).conditions[0]).toMatchObject({ severity: 'critical' });
  });
  it('disk gisterezisi: ochiq hodisa chegaradan 2 punkt pastgacha ushlanadi', () => {
    const tr = new MachineConditionTracker();
    const open = new Map<string, 'warn' | 'critical'>([['/', 'warn']]);
    expect(tr.evaluate(diskOf(84), T, 0, open).conditions).toHaveLength(1);
    expect(tr.evaluate(diskOf(82), T, 0, open).conditions).toHaveLength(0);
    const crit = new Map<string, 'warn' | 'critical'>([['/', 'critical']]);
    expect(tr.evaluate(diskOf(94), T, 0, crit).conditions[0]?.severity).toBe('critical');
    expect(tr.evaluate(diskOf(92), T, 0, crit).conditions[0]?.severity).toBe('warn');
  });
  it('xotira 90% faqat 5 daqiqa uzluksiz bo\'lgandan keyin; uzilish oynani nolga tushiradi', () => {
    const tr = new MachineConditionTracker();
    const hi = snap({ memory: { totalBytes: 100, usedBytes: 92, swapTotalBytes: 0, swapUsedBytes: 0 } });
    const lo = snap();
    expect(tr.evaluate(hi, T, 0, none).conditions).toEqual([]);
    expect(tr.evaluate(hi, T, 4 * MIN, none).conditions).toEqual([]);
    expect(tr.evaluate(hi, T, 5 * MIN, none).conditions[0]).toMatchObject({ kind: 'memory' });
    tr.evaluate(lo, T, 6 * MIN, none);
    expect(tr.evaluate(hi, T, 7 * MIN, none).conditions).toEqual([]);
    expect(tr.evaluate(hi, T, 11 * MIN, none).conditions).toEqual([]);
    expect(tr.evaluate(hi, T, 12 * MIN, none).conditions).toHaveLength(1);
  });
  it('CPU 95% 10 daqiqa; null o\'lchov oynani buzmaydi', () => {
    const tr = new MachineConditionTracker();
    const hi = snap({ cpu: { pct: 97, cores: 4 } });
    tr.evaluate(hi, T, 0, none);
    tr.evaluate(snap({ cpu: { pct: null, cores: 4 } }), T, 5 * MIN, none);
    expect(tr.evaluate(hi, T, 9 * MIN, none).conditions).toEqual([]);
    expect(tr.evaluate(hi, T, 10 * MIN, none).conditions[0]).toMatchObject({ kind: 'cpu' });
    tr.evaluate(snap({ cpu: { pct: 50, cores: 4 } }), T, 11 * MIN, none);
    expect(tr.evaluate(hi, T, 12 * MIN, none).conditions).toEqual([]);
  });
  it('konteyner: unhealthy warn, exited(1) critical, exited(0) yo\'q; docker mavjud emas = tekshirilmagan', () => {
    const tr = new MachineConditionTracker();
    const r = tr.evaluate(
      snap({ docker: { available: true, containers: [ctr('a', 'running', 'Up (unhealthy)', 0, 'unhealthy'), ctr('b', 'exited', 'Exited (1) 1m ago'), ctr('c', 'exited', 'Exited (0) 1m ago'), ctr('d', 'running', 'Up', 0, 'healthy')] } }),
      T, 0, none,
    );
    expect(r.conditions.map((c) => `${c.subject}:${c.severity}`).sort()).toEqual(['a:warn', 'b:critical']);
    expect(r.evaluated.has('container')).toBe(true);
    const off = tr.evaluate(snap({ docker: { available: false, containers: [], reason: 'no_access' } }), T, 0, none);
    expect(off.evaluated.has('container')).toBe(false);
    expect(tr.evaluate(snap(), T, 0, none).evaluated.has('systemd')).toBe(false);
  });
  it('restart-loop: 10 daqiqada +3 = critical; sekin o\'sish emas; qayta yaratilish oynani nollaydi', () => {
    const tr = new MachineConditionTracker();
    const at = (n: number) => snap({ docker: { available: true, containers: [ctr('w', 'running', 'Up 5 seconds', n)] } });
    expect(tr.evaluate(at(0), T, 0, none).conditions).toEqual([]);
    expect(tr.evaluate(at(2), T, 3 * MIN, none).conditions).toEqual([]);
    const r = tr.evaluate(at(3), T, 6 * MIN, none);
    expect(r.conditions[0]).toMatchObject({ kind: 'container', subject: 'w', severity: 'critical' });
    expect(r.conditions[0]?.summary).toContain('3 marta');
    // sekin: har 20 daqiqada 1 ta
    const slow = new MachineConditionTracker();
    for (let i = 0; i < 6; i++) expect(slow.evaluate(at(i), T, i * 20 * MIN, none).conditions).toEqual([]);
    // hisob kamaydi (konteyner qayta yaratilgan)
    const re = new MachineConditionTracker();
    re.evaluate(at(50), T, 0, none);
    expect(re.evaluate(at(0), T, MIN, none).conditions).toEqual([]);
    expect(re.evaluate(at(2), T, 2 * MIN, none).conditions).toEqual([]);
  });
  it('systemd failed unit', () => {
    const tr = new MachineConditionTracker();
    const r = tr.evaluate(snap({ systemd: { failed: ['nginx.service', 'x.timer [user]'] } }), T, 0, none);
    expect(r.conditions.map((c) => c.subject)).toEqual(['nginx.service', 'x.timer [user]']);
    expect(r.evaluated.has('systemd')).toBe(true);
  });
  it('mashina bo\'yicha override chegarasi', () => {
    const tr = new MachineConditionTracker();
    expect(tr.evaluate(diskOf(70), { ...T, diskWarnPct: 60 }, 0, none).conditions[0]?.severity).toBe('warn');
  });
});

describe('planIncidents (holat mashinasi)', () => {
  const c = (kind: Condition['kind'], subject: string, severity: Condition['severity'] = 'warn'): Condition => ({ kind, subject, severity, summary: 's' });
  const open = (id: string, kind: Condition['kind'], subject: string, severity: Condition['severity'] = 'warn') => ({ id, kind, subject, severity });
  const all = new Set<Condition['kind']>(['disk', 'memory', 'cpu', 'container', 'systemd']);

  it('yangi shart = open (bir marta); davom etayotgani keep (qayta xabar yo\'q)', () => {
    expect(planIncidents([], [c('disk', '/')], all).open).toHaveLength(1);
    const p = planIncidents([open('1', 'disk', '/')], [c('disk', '/')], all);
    expect(p.open).toEqual([]);
    expect(p.keep).toBe(1);
    expect(p.resolve).toEqual([]);
  });
  it('shart yo\'qolsa resolve; faqat tekshirilgan turlar', () => {
    const p = planIncidents([open('1', 'disk', '/'), open('2', 'container', 'web'), open('3', 'offline', '')], [], new Set(['disk']));
    expect(p.resolve.map((r) => r.id)).toEqual(['1']);
    expect(planIncidents([open('3', 'offline', '')], [], all).resolve).toEqual([]);
  });
  it('escalate warn->critical, downgrade critical->warn (jim)', () => {
    expect(planIncidents([open('1', 'disk', '/', 'warn')], [c('disk', '/', 'critical')], all).escalate).toHaveLength(1);
    const d = planIncidents([open('1', 'disk', '/', 'critical')], [c('disk', '/', 'warn')], all);
    expect(d.downgrade).toHaveLength(1);
    expect(d.escalate).toEqual([]);
  });
  it('subject bo\'yicha alohida hodisalar', () => {
    const p = planIncidents([open('1', 'disk', '/')], [c('disk', '/'), c('disk', '/data')], all);
    expect(p.open.map((x) => conditionKey(x.kind, x.subject))).toEqual(['disk|/data']);
  });
});

describe('resolveThresholds', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('sukut + global + mashina override', () => {
    expect(resolveThresholds({ defaults: {}, machines: {} }, id)).toEqual(T);
    const t = resolveThresholds({ defaults: { diskWarnPct: 80 }, machines: { [id]: { diskWarnPct: 70, cpuPct: 99 } } }, id);
    expect(t).toMatchObject({ diskWarnPct: 70, cpuPct: 99, memPct: 90 });
    expect(resolveThresholds({ defaults: { diskWarnPct: 80 }, machines: { [id]: { diskWarnPct: 70 } } }, null).diskWarnPct).toBe(80);
  });
  it('kritik chegara ogohlantirishdan past bo\'lmaydi', () => {
    expect(resolveThresholds({ defaults: { diskWarnPct: 98, diskCriticalPct: 90 }, machines: {} }, null).diskCriticalPct).toBe(98);
  });
});

describe('isBadContainer: qo\'lda to\'xtatish va eski chiqishlar', () => {
  const c = (status: string, state = 'exited', health = 'none') => ({ state, status, health });
  it('yaqinda xato kod bilan chiqqan — yomon', () => {
    expect(isBadContainer(c('Exited (1) 5 minutes ago'))).toBe(true);
    expect(isBadContainer(c('Exited (2) About an hour ago'))).toBe(true);
  });
  it('docker stop / SIGINT kodlari va 0 — yomon emas', () => {
    for (const code of [0, 130, 137, 143]) expect(isBadContainer(c(`Exited (${code}) 3 minutes ago`))).toBe(false);
  });
  it('bir kundan eski chiqish — hodisa emas', () => {
    expect(isBadContainer(c('Exited (1) 3 days ago'))).toBe(false);
    expect(isBadContainer(c('Exited (255) 2 weeks ago'))).toBe(false);
  });
  it('unhealthy va restarting doim yomon', () => {
    expect(isBadContainer(c('Up 2 hours (unhealthy)', 'running', 'unhealthy'))).toBe(true);
    expect(isBadContainer(c('Restarting (1) 10 seconds ago', 'restarting'))).toBe(true);
  });
});
