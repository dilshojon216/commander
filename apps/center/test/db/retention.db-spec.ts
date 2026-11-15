import { DataSource } from 'typeorm';
import { HYPERTABLE_POLICIES } from '../../src/retention/retention-policy.js';
import { RetentionService } from '../../src/retention/retention.service.js';
import { createThrowawayDb, openDataSource } from './helpers.js';

/** 5.2: retention + compression siyosatlari haqiqiy TimescaleDB'da mavjudligi va ishlashi. */

let ds: DataSource;
let drop: () => Promise<void>;
let machineId: string;
let projectId: string;

beforeAll(async () => {
  const db = await createThrowawayDb();
  drop = db.drop;
  ds = await openDataSource(db.url);
  await ds.runMigrations();
  const [m]: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ('ret-test', 'ret-test') RETURNING id`);
  machineId = m!.id;
  const [p]: Array<{ id: string }> = await ds.query(`SELECT upsert_project($1, '/work/ret', NULL, NULL, 'dir') AS id`, [machineId]);
  projectId = p!.id;
});

afterAll(async () => {
  await ds.destroy();
  await drop();
});

const days = (n: number): string => `now() - interval '${n} days'`;

describe('policies exist and are mutually consistent', () => {
  it('RetentionService.problems() is empty (retention, compression, cagg refresh windows, sweep job)', async () => {
    const svc = new RetentionService(ds);
    expect(await svc.problems()).toEqual([]);
  });

  it('every hypertable has the documented retention and compression window', async () => {
    const rows: Array<{ proc_name: string; hypertable_name: string; config: Record<string, string> }> = await ds.query(
      `SELECT proc_name, hypertable_name, config FROM timescaledb_information.jobs WHERE proc_name IN ('policy_retention', 'policy_compression')`,
    );
    const get = (proc: string, table: string) => rows.find((r) => r.proc_name === proc && r.hypertable_name === table)?.config;
    expect(get('policy_retention', 'session_events')?.['drop_after']).toBe('90 days');
    expect(get('policy_retention', 'token_usage')?.['drop_after']).toBe('30 days');
    expect(get('policy_retention', 'machine_health')?.['drop_after']).toBe('14 days');
    expect(get('policy_retention', 'limit_samples')?.['drop_after']).toBe('180 days');
    for (const [t, p] of Object.entries(HYPERTABLE_POLICIES)) {
      if (p.compressAfterDays !== null) expect(get('policy_compression', t)?.['compress_after']).toBe(`${p.compressAfterDays} days`);
    }
    expect(get('policy_compression', 'limit_samples')).toBeUndefined();
    const enabled: Array<{ hypertable_name: string; compression_enabled: boolean }> = await ds.query(
      `SELECT hypertable_name, compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name IN ('token_usage','session_events','machine_health') ORDER BY 1`,
    );
    expect(enabled.map((e) => [e.hypertable_name, e.compression_enabled])).toEqual([['machine_health', true], ['session_events', true], ['token_usage', true]]);
  });

  it('continuous aggregates have NO retention policy and refresh windows below raw retention', async () => {
    const svc = new RetentionService(ds);
    const jobs = await svc.jobs();
    for (const cagg of ['usage_5m', 'usage_1h', 'token_usage_daily_by_project', 'machine_health_5m']) {
      expect(jobs.some((j) => j.proc_name === 'policy_retention' && j.target === cagg)).toBe(false);
      expect(jobs.some((j) => j.proc_name === 'policy_refresh_continuous_aggregate' && j.target === cagg)).toBe(true);
    }
    const daily = jobs.find((j) => j.proc_name === 'policy_refresh_continuous_aggregate' && j.target === 'token_usage_daily_by_project');
    expect(daily?.config?.['start_offset']).toBe('25 days');
  });

  it('compression jobs do not start during the migration (no lock race with live inserts)', async () => {
    const rows: Array<{ next_start: Date }> = await ds.query(`SELECT next_start FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'`);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.next_start.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it('the daily sweep job exists and is scheduled in the future (not during migration)', async () => {
    const rows: Array<{ schedule_interval: string; next_start: Date }> = await ds.query(
      `SELECT schedule_interval::text, next_start FROM timescaledb_information.jobs WHERE proc_name = 'commander_retention_sweep'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.schedule_interval).toMatch(/1 day|24:00:00/);
    expect(rows[0]!.next_start.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('all-time daily statistics survive raw retention (cagg materialized beyond raw)', () => {
  const jobId = async (proc: string, target: string): Promise<number> => {
    const rows: Array<{ job_id: number }> = await ds.query(
      `SELECT j.job_id FROM timescaledb_information.jobs j
         LEFT JOIN timescaledb_information.continuous_aggregates c ON c.materialization_hypertable_name = j.hypertable_name
        WHERE j.proc_name = $1 AND COALESCE(c.view_name, j.hypertable_name) = $2`,
      [proc, target],
    );
    return rows[0]!.job_id;
  };

  it('daily per-project totals stay after the REAL retention + refresh jobs run on raw data older than 30 days', async () => {
    // 35 kun oldingi 3 ta so'rov: ular yoshligida (cagg oynasi ichida) materializatsiya qilingan edi; endi raw retention'dan eski.
    for (let i = 0; i < 3; i++) {
      await ds.query(
        `INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, source, project_id)
         VALUES (${days(35)} + ($3::int * interval '1 minute'), $1, $2, 'claude-test', 100, 10, 'otel', $4)`,
        [machineId, `old-${i}`, i, projectId],
      );
    }
    await ds.query(`INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, source, project_id) VALUES (now() - interval '2 hours', $1, 'new-0', 'claude-test', 7, 1, 'otel', $2)`, [machineId, projectId]);
    await ds.query(`CALL refresh_continuous_aggregate('token_usage_daily_by_project', now() - interval '40 days', now() - interval '1 hour')`);
    const sum = async (): Promise<{ input_tokens: string | null; requests: string | null }> =>
      (await ds.query(`SELECT sum(input_tokens)::text AS input_tokens, sum(requests)::text AS requests FROM token_usage_daily_by_project WHERE project_id = $1 AND "day" < now() - interval '30 days'`, [projectId]))[0];
    expect(await sum()).toEqual({ input_tokens: '300', requests: '3' });

    // Haqiqiy retention job'i: eski raw chunk o'chadi.
    await ds.query(`CALL run_job($1)`, [await jobId('policy_retention', 'token_usage')]);
    const raw: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM token_usage WHERE request_id LIKE 'old-%'`);
    expect(raw[0]!.n).toBe('0');

    // Haqiqiy refresh policy (start_offset 25 kun) ishlaydi: o'chirilgan oraliq oynadan tashqarida, statistika o'zgarmaydi.
    await ds.query(`CALL run_job($1)`, [await jobId('policy_refresh_continuous_aggregate', 'token_usage_daily_by_project')]);
    expect(await sum()).toEqual({ input_tokens: '300', requests: '3' });
    const totals: Array<{ requests: string }> = await ds.query(`SELECT requests::text FROM project_token_totals WHERE project_id = $1`, [projectId]);
    expect(Number(totals[0]!.requests)).toBeGreaterThanOrEqual(3);
  });

  it('a compressed chunk keeps serving reads and ignores duplicate inserts (ON CONFLICT DO NOTHING)', async () => {
    await ds.query(`INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, source) VALUES (date_trunc('milliseconds', ${days(12)}), $1, 'c-1', 'claude-test', 5, 1, 'otel')`, [machineId]);
    const compressed: Array<{ c: string }> = await ds.query(
      `SELECT compress_chunk(c, if_not_compressed => true)::text AS c FROM show_chunks('token_usage', older_than => now() - interval '3 days') c`,
    );
    expect(compressed.length).toBeGreaterThan(0);
    const stats: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'token_usage' AND is_compressed`);
    expect(Number(stats[0]!.n)).toBeGreaterThan(0);
    const rows: Array<{ input_tokens: string }> = await ds.query(`SELECT input_tokens::text FROM token_usage WHERE request_id = 'c-1'`);
    expect(rows).toEqual([{ input_tokens: '5' }]);
    // Aynan o'sha (machine, request, ts) qayta kelsa (agentd retry) jim e'tiborsiz.
    const [row]: Array<{ ts: Date }> = await ds.query(`SELECT ts FROM token_usage WHERE request_id = 'c-1'`);
    await ds.query(
      `INSERT INTO token_usage (ts, machine_id, request_id, model, input_tokens, output_tokens, source) VALUES ($1, $2, 'c-1', 'claude-test', 999, 1, 'otel') ON CONFLICT DO NOTHING`,
      [row!.ts, machineId],
    );
    const again: Array<{ n: string; input_tokens: string }> = await ds.query(`SELECT count(*)::text AS n, max(input_tokens)::text AS input_tokens FROM token_usage WHERE request_id = 'c-1'`);
    expect(again[0]).toEqual({ n: '1', input_tokens: '5' });
  });
});

describe('commander_retention_sweep (plain tables)', () => {
  it('prunes approvals/session_messages/reports by age, trims big old command results, never touches audit_log', async () => {
    const [d]: Array<{ id: string }> = await ds.query(`INSERT INTO devices (kind, name, token_hash, scopes) VALUES ('web', 'ret', 'h-ret', '{read}') RETURNING id`);
    const hash = 'a'.repeat(64);
    const mkApproval = (id: string, status: string, ageDays: number) =>
      ds.query(
        `INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, status, deadline, requested_at, resolved_at)
         VALUES (gen_random_uuid(), $1, $2, '/x', 'Bash', '', $3, $4, now(), now() - ($5::int * interval '1 day'), CASE WHEN $4 = 'pending' THEN NULL ELSE now() END)`,
        [machineId, id, hash, status, ageDays],
      );
    await mkApproval('old-denied', 'expired', 120);
    await mkApproval('old-pending', 'pending', 120);
    await mkApproval('fresh', 'expired', 5);

    const [s]: Array<{ id: string }> = await ds.query(`INSERT INTO sessions (machine_id, claude_session_id, cwd, project, status, started_at, status_since, last_seen_at) VALUES ($1, 'ret-s', '/x', 'x', 'idle', now(), now(), now()) RETURNING id`, [machineId]);
    const mkMsg = (subject: string, ageDays: number) =>
      ds.query(
        `INSERT INTO session_messages (batch_id, group_key, from_role, to_session_id, to_target, kind, subject, body, created_at)
         VALUES (gen_random_uuid(), 'g', 'backend', $1, 'x', 'info', $2, 'body', now() - ($3::int * interval '1 day'))`,
        [s!.id, subject, ageDays],
      );
    await mkMsg('old-msg', 45);
    await mkMsg('new-msg', 3);

    const mkReport = (start: string, ageDays: number) =>
      ds.query(`INSERT INTO reports (kind, period_start, period_end, data, generated_at) VALUES ('daily', $1, $1, '{}', now() - ($2::int * interval '1 day'))`, [start, ageDays]);
    await mkReport('2024-01-01', 400);
    await mkReport('2026-11-01', 10);

    const big = { blob: 'x'.repeat(5000) };
    const mkCmd = (nonce: string, ageDays: number, result: unknown) =>
      ds.query(
        `INSERT INTO commands (type, machine_id, status, requested_by_device_id, nonce, expires_at, result, finished_at)
         VALUES ('session.stop', $1, 'done', $2, $3, now(), $4::jsonb, now() - ($5::int * interval '1 day'))`,
        [machineId, d!.id, nonce, JSON.stringify(result), ageDays],
      );
    await mkCmd('big-old', 120, big);
    await mkCmd('small-old', 120, { ok: true });
    await mkCmd('big-new', 5, big);

    const auditBefore: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM audit_log`);
    await ds.query(`CALL commander_retention_sweep()`);

    const approvals: Array<{ claude_session_id: string }> = await ds.query(`SELECT claude_session_id FROM approvals ORDER BY 1`);
    expect(approvals.map((a) => a.claude_session_id)).toEqual(['fresh', 'old-pending']);
    const msgs: Array<{ subject: string }> = await ds.query(`SELECT subject FROM session_messages`);
    expect(msgs.map((m) => m.subject)).toEqual(['new-msg']);
    const reports: Array<{ period_start: Date }> = await ds.query(`SELECT period_start FROM reports`);
    expect(reports).toHaveLength(1);

    const cmds: Array<{ nonce: string; result: Record<string, unknown> }> = await ds.query(`SELECT nonce, result FROM commands ORDER BY nonce`);
    const by = Object.fromEntries(cmds.map((c) => [c.nonce, c.result]));
    expect(by['big-old']).toMatchObject({ trimmed: true });
    expect(by['small-old']).toEqual({ ok: true });
    expect(by['big-new']).toEqual(big);
    expect(Object.keys(by)).toHaveLength(3); // qatorlar saqlanadi

    const auditAfter: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM audit_log`);
    expect(auditAfter[0]!.n).toBe(auditBefore[0]!.n);
    await ds.query(`INSERT INTO audit_log (actor_kind, action) VALUES ('system', 'retention.test')`);
    await expect(ds.query(`DELETE FROM audit_log`)).rejects.toThrow(); // append-only trigger

    // Qayta ishga tushirish idempotent.
    await ds.query(`CALL commander_retention_sweep()`);
    const again: Array<{ n: string }> = await ds.query(`SELECT count(*)::text AS n FROM approvals`);
    expect(again[0]!.n).toBe('2');
  });
});

describe('status report', () => {
  it('RetentionService.status() returns counts and chunk compression numbers', async () => {
    const st = await new RetentionService(ds).status();
    expect(st.problems).toEqual([]);
    expect(st.counts['audit_log']).toBeGreaterThanOrEqual(0);
    const tu = st.chunks.find((c) => c.table === 'token_usage');
    expect(tu?.compressed).toBeGreaterThan(0);
  });
});
