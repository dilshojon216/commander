import { DataSource } from 'typeorm';
import { DEFAULT_HEALTH_THRESHOLDS, MachineHealthResponseSchema, HealthSummaryResponseSchema } from '@commander/contracts';
import type { AgentHealthPayload, DomainEventLike } from './health-types.js';
import { HealthIncidentsService } from '../../src/health/health-incidents.service.js';
import { HealthThresholdsService } from '../../src/health/health-thresholds.service.js';
import { MachineHealthService } from '../../src/health/machine-health.service.js';
import { RealtimeBus } from '../../src/realtime/realtime-bus.js';
import { createThrowawayDb, openDataSource } from './helpers.js';

const payload = (over: Partial<AgentHealthPayload> = {}): AgentHealthPayload => ({
  kind: 'full',
  collectedAt: Date.now(),
  platform: 'linux',
  cpu: { pct: 42.5, cores: 4 },
  memory: { totalBytes: 1000, usedBytes: 600, swapTotalBytes: 0, swapUsedBytes: 0 },
  uptimeSec: 10,
  disks: [{ mount: '/', totalBytes: 100, usedBytes: 88, pct: 88 }, { mount: '/data', totalBytes: 100, usedBytes: 10, pct: 10 }],
  topProcesses: { byCpu: [], byMem: [] },
  docker: { available: true, containers: [{ name: 'web', image: 'nginx', state: 'exited', status: 'Exited (1) 1m ago', restartCount: 0, health: 'none' }] },
  ...over,
});

describe('machine_health (3.8)', () => {
  let db: Awaited<ReturnType<typeof createThrowawayDb>>;
  let ds: DataSource;
  let svc: MachineHealthService;
  let incidents: HealthIncidentsService;
  let thresholds: HealthThresholdsService;
  let machineId: string;
  const events: DomainEventLike[] = [];

  beforeAll(async () => {
    db = await createThrowawayDb();
    ds = await openDataSource(db.url);
    await ds.runMigrations();
    const bus = new RealtimeBus();
    bus.subscribe((e) => void events.push(e));
    incidents = new HealthIncidentsService(ds);
    thresholds = new HealthThresholdsService(ds);
    svc = new MachineHealthService(ds, bus, incidents, thresholds);
    const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname, identity_status) VALUES ('hm', 'hm-host', 'verified') RETURNING id`);
    machineId = (m as { id: string }).id;
  }, 120_000);
  afterAll(async () => {
    await ds.destroy();
    await db.drop();
  });

  it('hypertable + cagg + retention + policy mavjud', async () => {
    const h: Array<{ hypertable_name: string }> = await ds.query(`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'machine_health'`);
    expect(h).toHaveLength(1);
    const c: Array<{ view_name: string }> = await ds.query(`SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'machine_health_5m'`);
    expect(c).toHaveLength(1);
    const jobs: Array<{ proc_name: string; config: { drop_after?: string } }> = await ds.query(
      `SELECT proc_name, config FROM timescaledb_information.jobs WHERE hypertable_name = 'machine_health' AND proc_name = 'policy_retention'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.config.drop_after).toBe('14 days');
    const pk: Array<{ attname: string }> = await ds.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'machine_health'::regclass AND i.indisprimary ORDER BY 1`,
    );
    expect(pk.map((p) => p.attname)).toEqual(['machine_id', 'ts']);
  });

  it('ingest: qatorlar, latest, bus hodisasi; haddan tez ikkinchi yuk tashlanadi', async () => {
    const now = Date.now();
    expect(await svc.ingest(machineId, payload({ collectedAt: now }), now)).toBe(true);
    expect(await svc.ingest(machineId, payload({ collectedAt: now + 1000 }), now + 1000)).toBe(false);
    const rows: Array<{ cpu: string; mem_pct: string; disk_max_pct: string }> = await ds.query(`SELECT cpu, mem_pct, disk_max_pct FROM machine_health WHERE machine_id = $1`, [machineId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ cpu: '42.5', mem_pct: '60.0', disk_max_pct: '88.0' });
    expect(events.some((e) => e.type === 'health.changed')).toBe(true);
    const latest = await svc.latest(machineId);
    expect(latest?.snapshot.disks).toHaveLength(2);
  });

  it('delta: faqat o\'zgargan bo\'lim, latest birlashtiriladi; kesh bo\'lmasa DB\'dan', async () => {
    const t = Date.now() + 10_000;
    await svc.ingest(machineId, { kind: 'delta', collectedAt: t, platform: 'linux', cpu: { pct: 10, cores: 4 }, memory: payload().memory, uptimeSec: 40, docker: { available: true, containers: [] } }, t);
    const fresh = new MachineHealthService(ds, new RealtimeBus(), incidents, thresholds); // kesh yo'q: DB'dan o'qiydi
    const latest = await fresh.latest(machineId);
    expect(latest?.snapshot.cpu.pct).toBe(10);
    expect(latest?.snapshot.docker?.containers).toEqual([]);
    expect(latest?.snapshot.disks).toHaveLength(2); // delta'da yo'q edi: saqlangan
  });

  it('kelajakdagi collectedAt now ga tushiriladi; bir xil ts dublikati e\'tiborsiz', async () => {
    const now = Date.now() + 30_000;
    await svc.ingest(machineId, payload({ collectedAt: now + 10 * 60_000 }), now);
    const [{ max }] = (await ds.query(`SELECT max(ts) AS max FROM machine_health WHERE machine_id = $1`, [machineId])) as Array<{ max: Date }>;
    expect(max.getTime()).toBeLessThanOrEqual(now);
  });

  it('REST javob shakli: range 6h/24h/7d, sxemaga mos', async () => {
    for (const range of ['6h', '24h', '7d'] as const) {
      const r = await svc.machineHealth(machineId, range);
      expect(MachineHealthResponseSchema.safeParse(r).success).toBe(true);
      expect(r.latest).not.toBeNull();
    }
    const six = await svc.machineHealth(machineId, '6h');
    expect(six.series.length).toBeGreaterThan(0);
    expect(six.series[0]?.diskMaxPct).toBe(88);
    await expect(svc.machineHealth('00000000-0000-4000-8000-000000000000', '24h')).rejects.toThrow(/machine not found/);
  });

  it('cagg: refresh dan keyin 5 daqiqalik bucket (24h/7d qatorlari)', async () => {
    await ds.query(`CALL refresh_continuous_aggregate('machine_health_5m', NULL, NULL)`);
    const r = await svc.machineHealth(machineId, '24h');
    expect(r.series.length).toBeGreaterThan(0);
    const d7 = await svc.machineHealth(machineId, '7d');
    expect(d7.series.length).toBeGreaterThan(0);
  });

  it('incidents: ochiq hodisa noyob; resolve bir marta; summary va status', async () => {
    const c = { kind: 'disk' as const, subject: '/', severity: 'warn' as const, summary: 'Disk /: 88%' };
    const id = await incidents.create(machineId, c);
    expect(id).not.toBeNull();
    expect(await incidents.create(machineId, c)).toBeNull();
    const online = await svc.statusOf(machineId, true);
    expect(online.status).toBe('warn');
    const sum = await svc.summary();
    expect(HealthSummaryResponseSchema.safeParse(sum).success).toBe(true);
    expect(sum.items[0]).toMatchObject({ name: 'hm-host', openIncidents: 1, diskMaxPct: 88, status: 'warn' });
    expect(sum.worst).toBe('warn');
    expect(await incidents.resolve(id as string)).toBe(true);
    expect(await incidents.resolve(id as string)).toBe(false);
    expect(await incidents.create(machineId, c)).not.toBeNull(); // yopilgandan keyin yangi hodisa mumkin
    const list = await incidents.list({ state: 'all', limit: 10, machineId });
    expect(list).toHaveLength(2);
    expect(list[0]?.resolvedAt).toBeNull(); // ochiq oldin
  });

  it('chegaralar: settings, mashina override, null o\'chiradi', async () => {
    expect(await thresholds.forMachine(machineId)).toEqual(DEFAULT_HEALTH_THRESHOLDS);
    await thresholds.put({ defaults: { diskWarnPct: 80 }, machines: { [machineId]: { cpuPct: 99 } } });
    const t = await thresholds.forMachine(machineId);
    expect(t).toMatchObject({ diskWarnPct: 80, cpuPct: 99 });
    const got = await thresholds.get();
    expect(got.machines[machineId]).toEqual({ cpuPct: 99 });
    await thresholds.put({ machines: { [machineId]: null } });
    expect((await thresholds.forMachine(machineId)).cpuPct).toBe(DEFAULT_HEALTH_THRESHOLDS.cpuPct);
  });

  it('ikki marta yuborilgan bir xil ts: PK ON CONFLICT DO NOTHING', async () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 2; i++) {
      await ds.query(`INSERT INTO machine_health (ts, machine_id, metrics) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (machine_id, ts) DO NOTHING`, [ts, machineId]);
    }
    const [{ n }] = (await ds.query(`SELECT count(*)::int AS n FROM machine_health WHERE ts = $1`, [ts])) as Array<{ n: number }>;
    expect(n).toBe(1);
  });
});
