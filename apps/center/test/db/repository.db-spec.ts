import { DataSource } from 'typeorm';
import { AuditLog } from '../../src/database/entities/audit-log.entity.js';
import { Command } from '../../src/database/entities/command.entity.js';
import { Device } from '../../src/database/entities/device.entity.js';
import { LimitSample } from '../../src/database/entities/limit-sample.entity.js';
import { Machine } from '../../src/database/entities/machine.entity.js';
import { TokenUsage } from '../../src/database/entities/token-usage.entity.js';
import { createThrowawayDb, openDataSource, pausePolicyJobs } from './helpers.js';

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

async function makeMachine(slug: string): Promise<Machine> {
  return ds.getRepository(Machine).save({ slug, identityStatus: 'verified', hardwareId: `hw-${slug}` });
}

describe('identity tables', () => {
  it('machine identity does not depend on hostname; hardware_id/legacy_host are unique', async () => {
    const m = await ds.getRepository(Machine).save({
      slug: 'mbp', hostname: 'Users-MacBook-Pro.local', hardwareId: 'hw-mbp', identityStatus: 'verified',
    });
    await ds.getRepository(Machine).update({ id: m.id }, { hostname: 'Users-MBP.SSS' });
    const again = await ds.getRepository(Machine).findOneByOrFail({ hardwareId: 'hw-mbp' });
    expect(again.id).toBe(m.id);
    await expect(ds.getRepository(Machine).save({ slug: 'mbp2', hardwareId: 'hw-mbp' })).rejects.toThrow(/uq_machines_hardware_id/);
  });

  it('agentd device requires machine + 32-byte public key', async () => {
    const m = await makeMachine('dev-m');
    const repo = ds.getRepository(Device);
    await expect(repo.save({ kind: 'agentd', machineId: m.id })).rejects.toThrow(/chk_devices_agentd_identity/);
    await expect(repo.save({ kind: 'agentd', machineId: m.id, publicKey: Buffer.alloc(31) })).rejects.toThrow(/chk_devices_public_key_len/);
    const d = await repo.save({ kind: 'agentd', machineId: m.id, publicKey: Buffer.alloc(32, 7), scopes: ['read'] });
    expect((await repo.findOneByOrFail({ id: d.id })).scopes).toEqual(['read']);
    await expect(repo.save({ kind: 'agentd', machineId: m.id, publicKey: Buffer.alloc(32, 7) })).rejects.toThrow(/uq_devices_public_key/);
  });
});

describe('token_usage hypertable', () => {
  it('has no PII columns', async () => {
    const cols: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('token_usage', 'usage_5m', 'usage_1h')`,
    );
    const names = cols.map((c) => c.column_name).join(',');
    expect(names).not.toMatch(/email|account|organization|user/);
  });

  it('dedups on (machine_id, request_id, ts); the same request_id with another ts is a separate row', async () => {
    const m = await makeMachine('usage-m');
    const repo = ds.getRepository(TokenUsage);
    const base = {
      machineId: m.id, requestId: 'req_1', model: 'claude-opus-4', source: 'otel' as const,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUsd: '0.123456',
    };
    const ts = new Date();
    await repo.insert({ ...base, ts });
    await expect(repo.insert({ ...base, ts })).rejects.toThrow(/pk_token_usage|duplicate key/);
    await repo.createQueryBuilder().insert().values({ ...base, ts }).orIgnore().execute();
    expect(await repo.count({ where: { machineId: m.id, requestId: 'req_1' } })).toBe(1);

    await repo.insert({ ...base, ts: new Date(ts.getTime() + 1000) });
    expect(await repo.count({ where: { machineId: m.id, requestId: 'req_1' } })).toBe(2);

    const row = await repo.findOneByOrFail({ machineId: m.id, requestId: 'req_1', ts });
    expect(row.inputTokens).toBe(10);
    expect(row.costUsd).toBe('0.123456');
  });

  it('continuous aggregates roll up per bucket/model (real-time + after refresh)', async () => {
    const m = await makeMachine('cagg-m');
    const repo = ds.getRepository(TokenUsage);
    const t = new Date(Date.now() - 2 * 3600_000);
    t.setUTCMinutes(1, 0, 0);
    const mk = (i: number, model: string, dt: number) => ({
      machineId: m.id, requestId: `c${i}`, ts: new Date(t.getTime() + dt), model, source: 'otel' as const,
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: '0.5',
    });
    await repo.insert([mk(1, 'm-a', 0), mk(2, 'm-a', 60_000), mk(3, 'm-b', 0), mk(4, 'm-a', 10 * 60_000)]);

    const query = (view: string) =>
      ds.query(
        `SELECT model, input_tokens::int AS input, requests::int AS requests, cost_usd::float AS cost
           FROM ${view} WHERE machine_id = $1 ORDER BY bucket, model`,
        [m.id],
      );
    // Real-time (materialized_only=false): refresh'siz ham ko'rinadi.
    expect(await query('usage_1h')).toEqual([
      { model: 'm-a', input: 300, requests: 3, cost: 1.5 },
      { model: 'm-b', input: 100, requests: 1, cost: 0.5 },
    ]);
    expect(await query('usage_5m')).toEqual([
      { model: 'm-a', input: 200, requests: 2, cost: 1 },
      { model: 'm-b', input: 100, requests: 1, cost: 0.5 },
      { model: 'm-a', input: 100, requests: 1, cost: 0.5 },
    ]);
    await ds.query(`CALL refresh_continuous_aggregate('usage_1h', NULL, now() - INTERVAL '1 hour')`);
    expect((await query('usage_1h'))[0]).toEqual({ model: 'm-a', input: 300, requests: 3, cost: 1.5 });
  });
});

describe('limit_samples hypertable', () => {
  it('each window is optional; source is mandatory/enumerated; empty sample rejected', async () => {
    const m = await makeMachine('limit-m');
    const repo = ds.getRepository(LimitSample);
    const ts = new Date();
    await repo.insert({ machineId: m.id, source: 'official', ts, sevenDayUsedPct: '41.50', sevenDayResetsAt: new Date(ts.getTime() + 86_400_000) });
    const row = await repo.findOneByOrFail({ machineId: m.id, source: 'official', ts });
    expect(row.fiveHourUsedPct).toBeNull();
    expect(row.fiveHourResetsAt).toBeNull();
    expect(row.sevenDayUsedPct).toBe('41.50');

    await expect(repo.insert({ machineId: m.id, source: 'estimate', ts })).rejects.toThrow(/chk_limit_samples_any/);
    await expect(
      ds.query(`INSERT INTO limit_samples (ts, machine_id, source, five_hour_used_pct) VALUES (now(), $1, 'guess', 1)`, [m.id]),
    ).rejects.toThrow(/chk_limit_samples_source/);
  });
});

describe('commands', () => {
  it('lifecycle columns, nonce replay protection, expiry mandatory', async () => {
    const m = await makeMachine('cmd-m');
    const d = await ds.getRepository(Device).save({ kind: 'web', tokenHash: 'h1' });
    const repo = ds.getRepository(Command);
    const base = {
      type: 'session.stop' as const, machineId: m.id, requestedByDeviceId: d.id,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const c = await repo.save({ ...base, nonce: 'n1', payload: { why: 'test' } });
    expect(c.status).toBe('pending');
    await expect(repo.save({ ...base, nonce: 'n1' })).rejects.toThrow(/uq_commands_requester_nonce/);
    await expect(repo.save({ ...base, nonce: 'n2', type: 'session.rm' as never })).rejects.toThrow(/chk_commands_type/);
    await expect(repo.save({ ...base, nonce: 'n3', status: 'bogus' as never })).rejects.toThrow(/chk_commands_status/);
  });
});

describe('audit_log', () => {
  const append = (action: string, details: Record<string, unknown> = {}) =>
    ds.getRepository(AuditLog).insert({ actorKind: 'system', action, details: details as never });

  it('append-only: UPDATE, DELETE and TRUNCATE are blocked', async () => {
    await append('a.one');
    await expect(ds.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(ds.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await expect(ds.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
  });

  it('hash chain links every row to the previous one, also under concurrency; verify() is NULL', async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => append('concurrent', { i })));
    const rows = await ds.getRepository(AuditLog).find({ order: { id: 'ASC' } });
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows[0].prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].hash);
    const v: Array<{ v: string | null }> = await ds.query(`SELECT audit_log_verify() AS v`);
    expect(v[0].v).toBeNull();
  });

  it('verify() detects tampering (trigger disabled by a superuser)', async () => {
    await append('victim');
    await ds.query(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_update_delete`);
    try {
      await ds.query(`UPDATE audit_log SET action = 'tampered' WHERE action = 'victim'`);
      const v: Array<{ v: string | null }> = await ds.query(`SELECT audit_log_verify() AS v`);
      expect(v[0].v).not.toBeNull();
    } finally {
      await ds.query(`UPDATE audit_log SET action = 'victim' WHERE action = 'tampered'`);
      await ds.query(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_update_delete`);
    }
    const v: Array<{ v: string | null }> = await ds.query(`SELECT audit_log_verify() AS v`);
    expect(v[0].v).toBeNull();
  });
});

describe('per-project token statistics', () => {
  const upsert = async (machineId: string, path: string, repoKey: string | null, kind = 'git'): Promise<string> => {
    const r: Array<{ id: string }> = await ds.query(`SELECT upsert_project($1, $2, $3, NULL, $4) AS id`, [machineId, path, repoKey, kind]);
    return r[0].id;
  };

  it('upsert_project creates once, returns the same id, backfills repo_key, names from path', async () => {
    const m = await makeMachine('proj-m');
    const a = await upsert(m.id, '/w/alpha/', null, 'dir');
    expect(await upsert(m.id, '/w/alpha/', null, 'dir')).toBe(a);
    const row0 = await ds.query(`SELECT name, kind, repo_key FROM projects WHERE id = $1`, [a]);
    expect(row0[0]).toEqual({ name: 'alpha', kind: 'dir', repo_key: null });
    expect(await upsert(m.id, '/w/alpha/', 'github.com/o/alpha')).toBe(a); // keyin git remote topildi
    const row1 = await ds.query(`SELECT kind, repo_key FROM projects WHERE id = $1`, [a]);
    expect(row1[0]).toEqual({ kind: 'git', repo_key: 'github.com/o/alpha' });
    expect(await upsert(m.id, '/w/other', null)).not.toBe(a);
  });

  it('daily cagg uses Asia/Tashkent day boundaries; totals/rollup views sum correctly; survives raw drop', async () => {
    const mac = await makeMachine('stat-mac');
    const srv = await makeMachine('stat-srv');
    const alphaMac = await upsert(mac.id, '/Users/me/alpha', 'github.com/o/alpha');
    const alphaSrv = await upsert(srv.id, '/srv/alpha', 'github.com/o/alpha'); // o'sha repo, boshqa mashina
    const beta = await upsert(mac.id, '/Users/me/beta', null, 'dir');

    // Tashkent (UTC+5) yarim tunidan 10 daqiqa oldin/keyin; 5 kun oldingi sana (refresh oynasi ichida).
    const x = new Date(Date.now() - 5 * 86_400_000);
    const midnight = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 0, 0) - 5 * 3600_000; // X 00:00 local
    const repo = ds.getRepository(TokenUsage);
    let n = 0;
    const row = (machineId: string, projectId: string | null, at: number, input: number, cost: string) => ({
      machineId, projectId, requestId: `st${++n}`, ts: new Date(at), model: 'm-x', source: 'otel' as const,
      inputTokens: input, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3, costUsd: cost,
    });
    await repo.insert([
      row(mac.id, alphaMac, midnight - 10 * 60_000, 100, '1.0'), // kun X-1, 23:50 local
      row(mac.id, alphaMac, midnight + 10 * 60_000, 200, '2.0'), // kun X, 00:10 local
      row(srv.id, alphaSrv, midnight + 20 * 60_000, 400, '4.0'), // kun X, boshqa mashinada o'sha repo
      row(mac.id, beta, midnight + 30 * 60_000, 800, '8.0'), // kun X, boshqa loyiha
      row(mac.id, null, midnight + 40 * 60_000, 1600, '16.0'), // cwd noma'lum
    ]);

    const daily = async () =>
      (await ds.query(
        `SELECT extract(epoch FROM day)::bigint * 1000 AS day_ms, project_id, input_tokens::int AS input, requests::int AS requests
           FROM token_usage_daily_by_project WHERE project_id = ANY($1::uuid[]) OR (project_id IS NULL AND input_tokens = 1600)
          ORDER BY day, input_tokens`,
        [[alphaMac, alphaSrv, beta]],
      )) as Array<{ day_ms: string; project_id: string | null; input: number; requests: number }>;
    const expected = [
      { day_ms: String(midnight - 86_400_000), project_id: alphaMac, input: 100, requests: 1 },
      { day_ms: String(midnight), project_id: alphaMac, input: 200, requests: 1 },
      { day_ms: String(midnight), project_id: alphaSrv, input: 400, requests: 1 },
      { day_ms: String(midnight), project_id: beta, input: 800, requests: 1 },
      { day_ms: String(midnight), project_id: null, input: 1600, requests: 1 },
    ].sort((a, b) => Number(a.day_ms) - Number(b.day_ms) || a.input - b.input);

    expect(await daily()).toEqual(expected); // real-time (refresh'siz)

    const check = async () => {
      const t = await ds.query(
        `SELECT input_tokens::int AS input, requests::int AS requests, cost_usd::float AS cost,
                extract(epoch FROM first_used_at)::bigint * 1000 AS first_ms, extract(epoch FROM last_used_at)::bigint * 1000 AS last_ms
           FROM project_token_totals WHERE project_id = $1`, [alphaMac]);
      expect(t[0]).toEqual({ input: 300, requests: 2, cost: 3, first_ms: String(midnight - 86_400_000), last_ms: String(midnight) });

      // Repo bo'yicha rollup: Mac + server bitta kalitga; dir-loyiha o'z id'si bilan; NULL -> 'unknown'.
      const r: Array<{ project_key: string; projects: number; input: number }> = await ds.query(
        `SELECT project_key, projects, input_tokens::int AS input FROM repo_token_totals
          WHERE project_key = ANY($1) ORDER BY project_key`,
        [['github.com/o/alpha', beta, 'unknown']],
      );
      const byKey = Object.fromEntries(r.map((x) => [x.project_key, x]));
      expect(byKey['github.com/o/alpha']).toMatchObject({ projects: 2, input: 700 });
      expect(byKey[beta]).toMatchObject({ projects: 1, input: 800 });
      expect(byKey['unknown'].input).toBeGreaterThanOrEqual(1600);

      const d: Array<{ input: number }> = await ds.query(
        `SELECT input_tokens::int AS input FROM token_usage_daily_total WHERE extract(epoch FROM day)::bigint * 1000 = $1`, [midnight]);
      expect(d[0].input).toBe(200 + 400 + 800 + 1600);
    };
    await check();

    // Materializatsiya, so'ng raw chunk'larni o'chirish: statistika o'zgarmaydi.
    await ds.query(`CALL refresh_continuous_aggregate('token_usage_daily_by_project', now() - INTERVAL '25 days', now() - INTERVAL '1 hour')`);
    await ds.query(`SELECT drop_chunks('token_usage', older_than => now() + INTERVAL '1 day')`);
    expect(await repo.count({ where: { machineId: mac.id } })).toBe(0);
    expect(await daily()).toEqual(expected);
    await check();
  });
});
