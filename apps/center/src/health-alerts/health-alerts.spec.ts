import { describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_THRESHOLDS } from '@commander/contracts';
import type { HealthIncidentDto, HealthSnapshot } from '@commander/contracts';
import { HealthAlertsService } from './health-alerts.service.js';
import { formatDuration, formatIncidentOpened, formatIncidentResolved } from './health-alert-format.js';
import type { Condition } from '../health/health-rules.js';

class FakeIncidents {
  rows: Array<HealthIncidentDto & { notified: boolean }> = [];
  private n = 0;
  async open(machineId: string) {
    return this.rows.filter((r) => r.machineId === machineId && !r.resolvedAt).map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, severity: r.severity }));
  }
  async create(machineId: string, c: Condition) {
    if (this.rows.some((r) => r.machineId === machineId && r.kind === c.kind && r.subject === c.subject && !r.resolvedAt)) return null;
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
    this.rows.push({ id, machineId, machineName: 'm', kind: c.kind, subject: c.subject, severity: c.severity, summary: c.summary, openedAt: new Date(0).toISOString(), resolvedAt: null, notified: false });
    return id;
  }
  async update(id: string, c: Condition) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, { severity: c.severity, summary: c.summary });
  }
  async resolve(id: string) {
    const r = this.rows.find((x) => x.id === id && !x.resolvedAt);
    if (!r) return false;
    r.resolvedAt = new Date(1).toISOString();
    return true;
  }
  async markNotified(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.notified = true;
  }
  async get(id: string) {
    return this.rows.find((x) => x.id === id) ?? null;
  }
}

function setup() {
  const incidents = new FakeIncidents();
  const sent: string[] = [];
  const ds = { query: async (sql: string) => (sql.includes('FROM machines WHERE id') ? [{ name: 'prod-1' }] : []) };
  const thresholds = { forMachine: async () => DEFAULT_HEALTH_THRESHOLDS };
  const health = { onSnapshot: () => undefined };
  const telegram = { notifyText: async (t: string) => (sent.push(t), 1) };
  const svc = new HealthAlertsService(ds as never, health as never, incidents as never, thresholds as never, telegram as never);
  return { svc, incidents, sent };
}
const snap = (pct: number, over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  collectedAt: 0, platform: 'linux', cpu: { pct: 1, cores: 1 },
  memory: { totalBytes: 100, usedBytes: 10, swapTotalBytes: 0, swapUsedBytes: 0 }, uptimeSec: 1,
  disks: [{ mount: '/', totalBytes: 100, usedBytes: pct, pct }], topProcesses: { byCpu: [], byMem: [] }, ...over,
});
const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('HealthAlertsService', () => {
  it('bir hodisa uchun bir marta xabar; takroriy snapshot yangi xabar bermaydi; tiklanganda "tiklandi"', async () => {
    const { svc, incidents, sent } = setup();
    await svc.evaluate(M, snap(90), 0);
    await svc.evaluate(M, snap(91), 30_000);
    await svc.evaluate(M, snap(92), 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('prod-1');
    expect(incidents.rows).toHaveLength(1);
    expect(incidents.rows[0]?.notified).toBe(true);
    await svc.evaluate(M, snap(50), 90_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Tiklandi');
    expect(incidents.rows[0]?.resolvedAt).not.toBeNull();
    await svc.evaluate(M, snap(50), 120_000);
    expect(sent).toHaveLength(2);
  });
  it('warn -> critical: yana bir marta xabar; critical -> warn: jim', async () => {
    const { svc, sent, incidents } = setup();
    await svc.evaluate(M, snap(86), 0);
    await svc.evaluate(M, snap(96), 1000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Jiddiylashdi');
    await svc.evaluate(M, snap(90), 2000);
    expect(sent).toHaveLength(2);
    expect(incidents.rows[0]?.severity).toBe('warn');
  });
  it('docker o\'chiq bo\'lsa konteyner hodisasi tiklandi bo\'lib qolmaydi', async () => {
    const { svc, sent } = setup();
    const bad = snap(10, { docker: { available: true, containers: [{ name: 'web', image: 'i', state: 'exited', status: 'Exited (1) 1m ago', restartCount: 0, health: 'none' }] } });
    await svc.evaluate(M, bad, 0);
    expect(sent).toHaveLength(1);
    await svc.evaluate(M, snap(10, { docker: { available: false, containers: [], reason: 'no_access' } }), 1000);
    expect(sent).toHaveLength(1);
    await svc.evaluate(M, snap(10, { docker: { available: true, containers: [] } }), 2000);
    expect(sent).toHaveLength(2);
  });
  it('xotira: 5 daqiqa; failed unit; telegram xatosi hodisani yiqitmaydi', async () => {
    const incidents = new FakeIncidents();
    const svc = new HealthAlertsService(
      { query: async () => [{ name: 'x' }] } as never, { onSnapshot: () => undefined } as never, incidents as never,
      { forMachine: async () => DEFAULT_HEALTH_THRESHOLDS } as never, { notifyText: async () => { throw new Error('tg down'); } } as never,
    );
    await svc.evaluate(M, snap(10, { systemd: { failed: ['a.service'] } }), 0);
    expect(incidents.rows).toHaveLength(1);
    expect(incidents.rows[0]?.notified).toBe(false);
  });
});

describe('sweepOffline', () => {
  function offlineSetup(machines: Array<{ id: string; name: string; online: boolean; since: Date | null }>, open: Array<{ id: string; machine_id: string }>) {
    const incidents = new FakeIncidents();
    for (const o of open) incidents.rows.push({ id: o.id, machineId: o.machine_id, machineName: 'm', kind: 'offline', subject: '', severity: 'critical', summary: 'off', openedAt: new Date(0).toISOString(), resolvedAt: null, notified: true });
    const sent: string[] = [];
    const ds = { query: async (sql: string) => (sql.includes('FROM machines WHERE merged') ? machines : sql.includes('health_incidents') ? open : []) };
    const svc = new HealthAlertsService(ds as never, { onSnapshot: () => undefined } as never, incidents as never, { forMachine: async () => DEFAULT_HEALTH_THRESHOLDS } as never, { notifyText: async (t: string) => (sent.push(t), 1) } as never);
    return { svc, incidents, sent };
  }
  it('10 daqiqadan keyin bir marta; qaytsa "qayta aloqada"', async () => {
    const now = 100 * 60_000;
    const { svc, sent, incidents } = offlineSetup([{ id: M, name: 'prod-1', online: false, since: new Date(now - 11 * 60_000) }], []);
    await svc.sweepOffline(now);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('aloqada emas');
    expect(incidents.rows).toHaveLength(1);
    await svc.sweepOffline(now + 60_000);
    expect(sent).toHaveLength(1); // dublikat yo'q (ochiq hodisa)
  });
  it('9 daqiqa = hali yo\'q', async () => {
    const now = 100 * 60_000;
    const { svc, sent } = offlineSetup([{ id: M, name: 'p', online: false, since: new Date(now - 9 * 60_000) }], []);
    await svc.sweepOffline(now);
    expect(sent).toHaveLength(0);
  });
  it('online qaytdi: yopiladi va xabar', async () => {
    const { svc, sent, incidents } = offlineSetup([{ id: M, name: 'p', online: true, since: null }], [{ id: '00000000-0000-4000-8000-000000000099', machine_id: M }]);
    await svc.sweepOffline(10 * 60_000);
    expect(sent[0]).toContain('qayta aloqada');
    expect(incidents.rows[0]?.resolvedAt).not.toBeNull();
  });
});

describe('format', () => {
  it('HTML escape va davomiylik', () => {
    const t = formatIncidentOpened({ machineName: '<b>x&y', kind: 'disk', severity: 'critical', summary: 'a<c' });
    expect(t).toContain('&lt;b&gt;x&amp;y');
    expect(t).not.toContain('<b>x');
    expect(formatDuration(30_000)).toBe('1 daqiqadan kam');
    expect(formatDuration(5 * 60_000)).toBe('5 daq');
    expect(formatDuration(125 * 60_000)).toBe('2 soat 5 daq');
    expect(formatDuration(28 * 3_600_000)).toBe('1 kun 4 soat');
    expect(formatIncidentResolved({ machineName: 'm', kind: 'cpu', severity: 'warn', summary: 's' }, new Date(0), new Date(60_000))).toContain('1 daq');
  });
});
