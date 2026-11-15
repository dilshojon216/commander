import { DataSource } from 'typeorm';
import { CenterHealthResponseSchema } from '@commander/contracts';
import { CenterHealthService } from '../../src/center-health/center-health.service.js';
import { CenterIncidentsService } from '../../src/center-health/center-incidents.service.js';
import type { CenterProbes } from '../../src/center-health/center-probes.js';
import { createThrowawayDb, openDataSource, pausePolicyJobs } from './helpers.js';

/** 5.5: markaz o'z-o'zini kuzatishi: hodisa holat mashinasi, Telegram xabarlari (bir marta + tiklandi), backup heartbeat. */

let ds: DataSource;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createThrowawayDb();
  drop = db.drop;
  ds = await openDataSource(db.url);
  await ds.runMigrations();
  await pausePolicyJobs(ds); // yangi bazada policy job'lari bilan deadlock bo'lmasin (6.19)
});
afterAll(async () => {
  await ds.destroy();
  await drop();
});
beforeEach(async () => {
  await ds.query(`DELETE FROM center_incidents`);
  await ds.query(`DELETE FROM settings WHERE key = 'backup.last_success'`);
});

interface World {
  usedPct: number | null;
  dashboard: boolean | null;
  tailscale: boolean | null;
  lagP99Ms: number | null;
  rssBytes: number;
  heapUsedPct: number;
}
const world = (): World => ({ usedPct: 40, dashboard: true, tailscale: true, lagP99Ms: 5, rssBytes: 300 * 1024 ** 2, heapUsedPct: 30 });

function build(w: World, tg: { enabled: boolean; startedAt: number | null; lastOkAt: number | null } = { enabled: false, startedAt: null, lastOkAt: null }) {
  const sent: string[] = [];
  const probes: CenterProbes = {
    disk: () => (w.usedPct === null ? null : { usedPct: w.usedPct, freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
    http: async (t) => (t === 'dashboard' ? w.dashboard : w.tailscale),
    runtime: () => ({ lagP99Ms: w.lagP99Ms, rssBytes: w.rssBytes, heapUsedPct: w.heapUsedPct }),
    stop: () => undefined,
  };
  const telegram = { notifyText: async (t: string) => { sent.push(t); return 1; }, pollingStats: () => tg };
  const svc = new CenterHealthService(ds, new CenterIncidentsService(ds), { enabled: false, tickMs: 60_000, firstTickMs: 1 }, probes, telegram as never);
  return { svc, sent, tg };
}

const openKinds = async (): Promise<string[]> => (await ds.query(`SELECT kind FROM center_incidents WHERE resolved_at IS NULL ORDER BY kind`)).map((r: { kind: string }) => r.kind);
const backupAt = (msAgo: number) => ds.query(`INSERT INTO settings (key, value) VALUES ('backup.last_success', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ts: Math.floor((Date.now() - msAgo) / 1000) })]);
const H = 3_600_000;

describe('disk usage > 80%', () => {
  it('opens ONE incident + ONE Telegram message, escalates once, closes with "Tiklandi" after hysteresis', async () => {
    await backupAt(H);
    const w = world();
    const { svc, sent } = build(w);
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    expect(sent).toHaveLength(0);

    w.usedPct = 85;
    await svc.tick();
    await svc.tick(); // takror: yangi xabar yo'q
    expect(await openKinds()).toEqual(['db_disk']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('DB disk');
    expect(sent[0]).toContain('85%');

    w.usedPct = 95;
    await svc.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Jiddiylashdi');

    w.usedPct = 79; // gisterezis: hali yopilmaydi
    await svc.tick();
    expect(await openKinds()).toEqual(['db_disk']);
    expect(sent).toHaveLength(2);

    w.usedPct = 60;
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain('Tiklandi');
    const rows: Array<{ notified_at: Date | null; resolved_at: Date | null }> = await ds.query(`SELECT notified_at, resolved_at FROM center_incidents WHERE kind = 'db_disk'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notified_at).not.toBeNull();
    expect(rows[0]!.resolved_at).not.toBeNull();
  });

  it('an unmeasurable disk neither opens nor resolves anything', async () => {
    await backupAt(H);
    const w = world();
    w.usedPct = 90;
    const { svc, sent } = build(w);
    await svc.tick();
    expect(await openKinds()).toEqual(['db_disk']);
    w.usedPct = null;
    await svc.tick();
    expect(await openKinds()).toEqual(['db_disk']);
    expect(sent).toHaveLength(1);
  });
});

describe('backup freshness (settings heartbeat written by ops/mac/backup.sh)', () => {
  it('warns when the last successful backup is older than 26h and resolves when a new heartbeat arrives', async () => {
    const w = world();
    const { svc, sent } = build(w);
    await backupAt(27 * H);
    await svc.tick();
    expect(await openKinds()).toEqual(['backup']);
    expect(sent[0]).toContain('Zaxira');
    expect(sent[0]).toMatch(/27 soat/);

    await backupAt(60_000); // backup.sh yangi heartbeat yozdi
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    expect(sent.at(-1)).toContain('Tiklandi');
  });

  it('accepts epoch seconds and epoch milliseconds; ignores a malformed value', async () => {
    const w = world();
    const { svc } = build(w);
    await ds.query(`INSERT INTO settings (key, value) VALUES ('backup.last_success', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ts: Date.now() - H })]);
    let res = await svc.tick();
    expect(res.checks.find((c) => c.kind === 'backup')?.status).toBe('ok');
    await ds.query(`UPDATE settings SET value = '{"ts": "yesterday"}'::jsonb WHERE key = 'backup.last_success'`);
    res = await svc.tick();
    expect(res.checks.find((c) => c.kind === 'backup')?.status).toBe('unknown');
  });
});

describe('dashboard / Tailscale probes and runtime', () => {
  it('a single failed probe is tolerated; two consecutive failures open an incident; recovery closes it', async () => {
    await backupAt(H);
    const w = world();
    const { svc, sent } = build(w);
    w.dashboard = false;
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    await svc.tick();
    expect(await openKinds()).toEqual(['dashboard']);
    expect(sent).toHaveLength(1);
    w.dashboard = true;
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    expect(sent).toHaveLength(2);

    w.tailscale = false;
    await svc.tick();
    await svc.tick();
    expect(await openKinds()).toEqual(['tailscale']);
    expect(sent.at(-1)).toContain('Tailscale serve');
  });

  it('not-configured probes (null) stay disabled and never alert', async () => {
    await backupAt(H);
    const w = world();
    w.dashboard = null;
    w.tailscale = null;
    const { svc } = build(w);
    const res = await svc.tick();
    expect(res.checks.find((c) => c.kind === 'dashboard')?.status).toBe('disabled');
    expect(res.checks.find((c) => c.kind === 'tailscale')?.status).toBe('disabled');
    expect(res.status).toBe('ok');
  });

  it('sustained event-loop lag and high memory open a runtime incident', async () => {
    await backupAt(H);
    const w = world();
    const { svc, sent } = build(w);
    w.lagP99Ms = 1500;
    await svc.tick();
    expect(await openKinds()).toEqual([]); // bitta tick: kutiladi
    await svc.tick();
    expect(await openKinds()).toEqual(['runtime']);
    expect(sent[0]).toContain('event-loop');
    w.lagP99Ms = 5;
    await svc.tick();
    expect(await openKinds()).toEqual([]);

    w.rssBytes = 4 * 1024 ** 3;
    await svc.tick();
    expect(await openKinds()).toEqual(['runtime']);
  });
});

describe('Telegram polling stuck', () => {
  it('opens when no successful getUpdates for > 120 s, closes when polling resumes', async () => {
    await backupAt(H);
    const w = world();
    const now = Date.now();
    const { svc, sent, tg } = build(w, { enabled: true, startedAt: now - 600_000, lastOkAt: now - 300_000 });
    await svc.tick();
    expect(await openKinds()).toEqual(['telegram']);
    expect(sent[0]).toContain('Telegram polling');
    tg.lastOkAt = Date.now() - 5_000;
    await svc.tick();
    expect(await openKinds()).toEqual([]);
    expect(sent.at(-1)).toContain('Tiklandi');
  });
});

describe('REST snapshot', () => {
  it('matches the contract, includes incidents and the 3.8 offline count', async () => {
    await backupAt(H);
    const w = world();
    w.usedPct = 92;
    const { svc } = build(w);
    const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ('ch-off', 'ch-off') RETURNING id`);
    await ds.query(`INSERT INTO health_incidents (machine_id, kind, severity, summary) VALUES ($1, 'offline', 'critical', 'x')`, [m!.id]);
    await svc.tick();
    const snap = CenterHealthResponseSchema.parse(await svc.snapshot());
    expect(snap.status).toBe('critical');
    expect(snap.machinesOffline).toBe(1);
    expect(snap.checks.map((c) => c.kind).sort()).toEqual(['backup', 'dashboard', 'db_disk', 'runtime', 'tailscale', 'telegram']);
    expect(snap.incidents.filter((i) => i.resolvedAt === null).map((i) => i.kind)).toEqual(['db_disk']);
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('the unique open index prevents duplicate open incidents per kind', async () => {
    const inc = new CenterIncidentsService(ds);
    const first = await inc.create({ kind: 'backup', severity: 'warn', summary: 'a' });
    const second = await inc.create({ kind: 'backup', severity: 'warn', summary: 'b' });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await inc.resolve(first!)).not.toBeNull();
    expect(await inc.resolve(first!)).toBeNull(); // ikki marta "tiklandi" yo'q
    expect(await inc.create({ kind: 'backup', severity: 'warn', summary: 'c' })).not.toBeNull();
  });
});
