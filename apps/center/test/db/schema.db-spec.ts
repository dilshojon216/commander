import { DataSource } from 'typeorm';
import { ENTITIES, MIGRATIONS } from '../../src/database/database.config.js';
import { InitSchema1731400000000 } from '../../src/database/migrations/1731400000000-InitSchema.js';
import { createThrowawayDb, openDataSource } from './helpers.js';

const V2_TABLES = [
  'machines', 'devices', 'projects', 'project_snapshots', 'sessions', 'session_events',
  'token_usage', 'limit_samples', 'commands', 'audit_log',
  'enrollment_codes', 'used_nonces', 'settings', 'machine_merge_candidates',
];

async function tables(ds: DataSource): Promise<string[]> {
  const rows: Array<{ table_name: string }> = await ds.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return rows.map((r) => r.table_name).sort();
}

describe('migrations on a fresh TimescaleDB', () => {
  it('up -> down (all) -> up', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      const up1 = await ds.runMigrations();
      expect(up1).toHaveLength(MIGRATIONS.length);
      expect(await tables(ds)).toEqual(expect.arrayContaining([...V2_TABLES, 'sessions_v0', 'session_events_v0']));

      const hyper: Array<{ hypertable_name: string }> = await ds.query(
        `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
      );
      expect(hyper.map((h) => h.hypertable_name)).toEqual(['limit_samples', 'machine_health', 'session_events', 'token_usage']);

      const caggs: Array<{ view_name: string }> = await ds.query(
        `SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1`,
      );
      expect(caggs.map((c) => c.view_name)).toEqual(['machine_health_5m', 'token_usage_daily_by_project', 'usage_1h', 'usage_5m']);

      const jobs: Array<{ proc_name: string; hypertable_name: string }> = await ds.query(
        `SELECT proc_name, hypertable_name FROM timescaledb_information.jobs
          WHERE proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate') ORDER BY 1, 2`,
      );
      expect(jobs.filter((j) => j.proc_name === 'policy_retention').map((j) => j.hypertable_name)).toEqual([
        'limit_samples', 'machine_health', 'session_events', 'token_usage',
      ]);
      expect(jobs.filter((j) => j.proc_name === 'policy_refresh_continuous_aggregate')).toHaveLength(4);

      for (let i = 0; i < MIGRATIONS.length; i++) await ds.undoLastMigration();
      expect(await tables(ds)).toEqual(['migrations']);

      const up2 = await ds.runMigrations();
      expect(up2).toHaveLength(MIGRATIONS.length);
      expect(await tables(ds)).toEqual(expect.arrayContaining(V2_TABLES));
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });

  it('entity columns match the migrated schema (no drift)', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      for (const entity of ENTITIES) {
        const meta = ds.getMetadata(entity);
        const rows: Array<{ column_name: string }> = await ds.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [meta.tableName],
        );
        const dbCols = rows.map((r) => r.column_name).sort();
        const entityCols = meta.columns.map((c) => c.databaseName).sort();
        expect(entityCols, meta.tableName).toEqual(dbCols);
      }
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('1.4 agent-channel migration', () => {
  it('awaiting_approval status, stale_since and machine presence columns; down maps awaiting_approval back to waiting', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      const [m] = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ('zz-m', 'zz') RETURNING id, online`);
      expect(m.online).toBe(false);
      await ds.query(
        `INSERT INTO sessions (machine_id, claude_session_id, cwd, project, status, started_at, status_since, last_seen_at, stale_since)
         VALUES ($1, 's', '/x', 'x', 'awaiting_approval', now(), now(), now(), now())`,
        [m.id],
      );
      await expect(
        ds.query(`UPDATE sessions SET status = 'stale' WHERE machine_id = $1`, [m.id]),
      ).rejects.toThrow(/chk_sessions_status/);

      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)

      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)

      await ds.undoLastMigration(); // ask questions (6.13)

      await ds.undoLastMigration(); // weekly pace (6.12)
      await ds.undoLastMigration(); // scans + budgets (6.10/6.11)
      await ds.undoLastMigration(); // deploy + checkpoints (6.5/6.9)
      await ds.undoLastMigration(); // billing (6.7/6.8)
      await ds.undoLastMigration(); // logs + investigations (6.4/6.6)
      await ds.undoLastMigration(); // intelligence (6.1-6.3)
      await ds.undoLastMigration(); // orchestration scope (H-05)
      await ds.undoLastMigration(); // center incidents (5.5)

      await ds.undoLastMigration(); // retention + compression (5.2)

      await ds.undoLastMigration(); // key rotation (5.1)

      await ds.undoLastMigration(); // client pairing
      await ds.undoLastMigration(); // git integration (3.5)
      await ds.undoLastMigration(); // orchestration (3.9)
      await ds.undoLastMigration(); // config sync (3.7)
      await ds.undoLastMigration(); // remote control (3.10)
      await ds.undoLastMigration(); // prompt templates (3.4)
      await ds.undoLastMigration(); // machine health (3.8)
      await ds.undoLastMigration(); // watchdog + reports (3.2/3.3)
      await ds.undoLastMigration(); // task queue (3.1)

      await ds.undoLastMigration(); // approval rules (2.13/2.14)
      await ds.undoLastMigration(); // messaging (2.10)

      await ds.undoLastMigration(); // project work (2.15)
      await ds.undoLastMigration(); // project tasks (2.8/2.9)
      await ds.undoLastMigration(); // remote commands (2.3)
      await ds.undoLastMigration(); // session permission_mode
      await ds.undoLastMigration(); // approvals (1.7)
      await ds.undoLastMigration(); // agent-channel
      const [s] = await ds.query(`SELECT status FROM sessions WHERE machine_id = $1`, [m.id]);
      expect(s.status).toBe('waiting');
      const cols: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM information_schema.columns WHERE (table_name = 'machines' AND column_name IN ('online', 'connected_at', 'disconnected_at', 'agentd_version', 'claude_version'))
            OR (table_name = 'sessions' AND column_name IN ('stale_since', 'transcript_path'))`,
      );
      expect(cols).toHaveLength(0);
      await ds.runMigrations();
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('0.6 identity migration', () => {
  it('down removes only its own objects (devices keeps working), up restores them', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)
      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)
      await ds.undoLastMigration(); // ask questions (6.13)
      await ds.undoLastMigration(); // weekly pace (6.12)
      await ds.undoLastMigration(); // scans + budgets (6.10/6.11)
      await ds.undoLastMigration(); // deploy + checkpoints (6.5/6.9)
      await ds.undoLastMigration(); // billing (6.7/6.8)
      await ds.undoLastMigration(); // logs + investigations (6.4/6.6)
      await ds.undoLastMigration(); // intelligence (6.1-6.3)
      await ds.undoLastMigration(); // orchestration scope (H-05)
      await ds.undoLastMigration(); // center incidents (5.5)
      await ds.undoLastMigration(); // retention + compression (5.2)
      await ds.undoLastMigration(); // key rotation (5.1)
      await ds.undoLastMigration(); // client pairing
      await ds.undoLastMigration(); // git integration (3.5)
      await ds.undoLastMigration(); // orchestration (3.9)
      await ds.undoLastMigration(); // config sync (3.7)
      await ds.undoLastMigration(); // remote control (3.10)
      await ds.undoLastMigration(); // prompt templates (3.4)
      await ds.undoLastMigration(); // machine health (3.8)
      await ds.undoLastMigration(); // watchdog + reports (3.2/3.3)
      await ds.undoLastMigration(); // task queue (3.1)
      await ds.undoLastMigration(); // approval rules (2.13/2.14)
      await ds.undoLastMigration(); // messaging (2.10)
      await ds.undoLastMigration(); // project work (2.15)
      await ds.undoLastMigration(); // project tasks (2.8/2.9)
      await ds.undoLastMigration(); // remote commands (2.3)
      await ds.undoLastMigration(); // session permission_mode
      await ds.undoLastMigration(); // approvals (1.7)
      await ds.undoLastMigration(); // agent-channel (1.4)
      await ds.undoLastMigration(); // identity
      const t = await tables(ds);
      for (const gone of ['enrollment_codes', 'used_nonces', 'settings', 'machine_merge_candidates']) expect(t).not.toContain(gone);
      expect(t).toEqual(expect.arrayContaining(['devices', 'machines', 'audit_log']));
      const cols: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'devices' AND column_name = 'expires_at'`,
      );
      expect(cols).toHaveLength(0);
      await ds.runMigrations();
      expect(await tables(ds)).toEqual(expect.arrayContaining(['enrollment_codes', 'used_nonces', 'settings', 'machine_merge_candidates']));
      // scopes CHECK
      const m: Array<{ id: string }> = await ds.query(`INSERT INTO machines (slug) VALUES ('s') RETURNING id`);
      await expect(
        ds.query(`INSERT INTO devices (machine_id, kind, public_key, scopes) VALUES ($1, 'agentd', $2, '{root}')`, [m[0]!.id, Buffer.alloc(32, 1)]),
      ).rejects.toThrow(/chk_devices_scopes/);
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('v0 -> v2 data move (production path)', () => {
  it('moves sessions/events keyed by machine, keeps API ids, flags legacy machines', async () => {
    const db = await createThrowawayDb();
    // 1) v0 holati: faqat InitSchema (Timescale'siz v0 dump restore qilingandek).
    const v0 = await openDataSource(db.url, [InitSchema1731400000000]);
    await v0.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
    await v0.runMigrations();
    const t = (m: number) => new Date(Date.UTC(2026, 10, 13, 10, m)).toISOString();
    await v0.query(
      `INSERT INTO sessions (host, session_id, cwd, project, status, message, notification_type, started_at, status_since, last_seen_at, ended_at)
       VALUES ('Host-A.local', 's1', '/w/alpha', 'alpha', 'working', NULL, NULL, $1, $1, $2, NULL),
              ('Host-A.local', 's2', '/w/beta', 'beta', 'ended', 'bye', NULL, $1, $2, $2, $2),
              ('Host-B.SSS', 's1', '/w/alpha', 'alpha', 'waiting', 'Needs approval', 'permission_prompt', $1, $2, $2, NULL)`,
      [t(0), t(5)],
    );
    await v0.query(
      `INSERT INTO session_events (host, session_id, event, status, message, client_ts, received_at) VALUES
        ('Host-A.local', 's1', 'SessionStart', 'idle', NULL, 1000, $1),
        ('Host-A.local', 's1', 'PreToolUse', 'working', NULL, 2000, $2),
        ('Host-B.SSS', 's1', 'Notification', 'waiting', 'Needs approval', 3000, $2)`,
      [t(0), t(5)],
    );
    const v0Events: Array<{ id: string; host: string; session_id: string }> = await v0.query(
      `SELECT id, host, session_id FROM session_events ORDER BY id`,
    );
    await v0.destroy();

    // 2) Yangi kod: qolgan migratsiyalar ishga tushadi.
    const ds = await openDataSource(db.url);
    try {
      const applied = await ds.runMigrations();
      expect(applied).toHaveLength(MIGRATIONS.length - 1);

      const machines: Array<Record<string, unknown>> = await ds.query(
        `SELECT hostname, legacy_host, identity_status, hardware_id FROM machines ORDER BY legacy_host`,
      );
      expect(machines).toEqual([
        { hostname: 'Host-A.local', legacy_host: 'Host-A.local', identity_status: 'legacy_unverified', hardware_id: null },
        { hostname: 'Host-B.SSS', legacy_host: 'Host-B.SSS', identity_status: 'legacy_unverified', hardware_id: null },
      ]);

      // Bir xil session_id turli mashinada alohida sessiya.
      const sessions: Array<{ host: string; sid: string; status: string; project: string }> = await ds.query(
        `SELECT m.legacy_host AS host, s.claude_session_id AS sid, s.status, s.project
           FROM sessions s JOIN machines m ON m.id = s.machine_id ORDER BY 1, 2`,
      );
      expect(sessions).toEqual([
        { host: 'Host-A.local', sid: 's1', status: 'working', project: 'alpha' },
        { host: 'Host-A.local', sid: 's2', status: 'ended', project: 'beta' },
        { host: 'Host-B.SSS', sid: 's1', status: 'waiting', project: 'alpha' },
      ]);

      const events: Array<{ id: string; host: string; sid: string; ts: Date; client_ts: string }> = await ds.query(
        `SELECT e.id, m.legacy_host AS host, s.claude_session_id AS sid, e.ts, e.client_ts
           FROM session_events e JOIN sessions s ON s.id = e.session_id JOIN machines m ON m.id = e.machine_id
          ORDER BY e.id`,
      );
      expect(events.map((e) => [e.id, e.host, e.sid])).toEqual(v0Events.map((e) => [e.id, e.host, e.session_id]));
      expect(events[1].ts.toISOString()).toBe(t(5));
      expect(events[1].client_ts).toBe('2000');

      // Identity ketma-ketligi v0 max(id) dan keyin davom etadi.
      const next: Array<{ id: string }> = await ds.query(
        `INSERT INTO session_events (session_id, machine_id, event, status)
         SELECT id, machine_id, 'X', 'idle' FROM sessions LIMIT 1 RETURNING id`,
      );
      expect(Number(next[0].id)).toBeGreaterThan(Math.max(...v0Events.map((e) => Number(e.id))));

      // Rollback: v2 holati v0 ga qaytariladi (yangi qator ham), keyin qayta up.
      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)
      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)
      await ds.undoLastMigration(); // ask questions (6.13)
      await ds.undoLastMigration(); // weekly pace (6.12)
      for (let i = 0; i < 32; i++) await ds.undoLastMigration(); // weekly pace (6.12), scans + budgets (6.10/6.11), deploy + checkpoints (6.5/6.9), billing (6.7/6.8), logs + investigations (6.4/6.6), intelligence (6.1-6.3), orchestration scope (H-05), center incidents (5.5), retention + compression (5.2), key rotation (5.1), client pairing, git integration (3.5), config sync (3.7), orchestration (3.9), remote control (3.10), prompt templates (3.4), machine health (3.8), task queue (3.1), approval rules, messaging, project work, project tasks, remote commands, permission_mode, approvals, agent-channel, identity, stats, audit, usage, move-data
      const back: Array<{ n: string }> = await ds.query(`SELECT count(*) AS n FROM session_events_v0`);
      expect(back[0].n).toBe('4');
      const hosts: Array<{ host: string }> = await ds.query(`SELECT DISTINCT host FROM sessions_v0 ORDER BY 1`);
      expect(hosts.map((h) => h.host)).toEqual(['Host-A.local', 'Host-B.SSS']);
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('2.13/2.14 approval rules migration', () => {
  it('CHECK: muddat <= 7 kun, vosita soni, qaror = qurilma YOKI qoida; down eski holatga qaytaradi', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      const [m] = await ds.query(`INSERT INTO machines (slug) VALUES ('zz-rl') RETURNING id`);
      const [dev] = await ds.query(`INSERT INTO devices (kind, name, token_hash, scopes) VALUES ('web', 'zz', 'h2', '{control}') RETURNING id`);
      const rule = (tools: string, interval: string) =>
        ds.query(`INSERT INTO approval_rules (scope, scope_ref, tools, expires_at, created_by_device_id) VALUES ('repo', 'github.com/a/b', '${tools}', now() + interval '${interval}', $1) RETURNING id`, [dev.id]);
      const [ok] = await rule('{Edit}', '7 days');
      await expect(rule('{Edit}', '8 days')).rejects.toThrow(/chk_approval_rules_expiry/);
      await expect(rule('{}', '1 hour')).rejects.toThrow(/chk_approval_rules_tools/);
      await expect(ds.query(`INSERT INTO approval_rules (scope, scope_ref, tools, expires_at, created_by_device_id) VALUES ('bogus', 'x', '{Edit}', now() + interval '1 hour', $1)`, [dev.id])).rejects.toThrow(/chk_approval_rules_scope/);
      const auto = (ruleId: string | null, decidedBy: string | null) =>
        ds.query(
          `INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, status, deadline, decided_at, resolved_at, decided_by_device_id, auto_rule_id)
           VALUES (gen_random_uuid(), $1, 's', '/x', 'Edit', '{}', $2, 'approved', now() + interval '5 minutes', now(), now(), $3, $4::bigint)`,
          [m.id, 'a'.repeat(64), decidedBy, ruleId],
        );
      await auto(ok.id, null); // qoida orqali: qurilmasiz
      await auto(null, dev.id); // odam orqali
      await expect(auto(null, null)).rejects.toThrow(/chk_approvals_decided/); // na qurilma, na qoida
      await expect(ds.query(`INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline, kind) VALUES (gen_random_uuid(), $1, 's', '/x', 'X', '', $2, now(), 'weird')`, [m.id, 'a'.repeat(64)])).rejects.toThrow(/chk_approvals_kind/);
      await expect(ds.query(`INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, deadline, kind, plan_text) VALUES (gen_random_uuid(), $1, 's', '/x', 'X', '', $2, now(), 'plan', $3)`, [m.id, 'a'.repeat(64), 'x'.repeat(16385)])).rejects.toThrow(/chk_approvals_plan_len/);

      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)

      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)

      await ds.undoLastMigration(); // ask questions (6.13)

      await ds.undoLastMigration(); // weekly pace (6.12)
      await ds.undoLastMigration(); // scans + budgets (6.10/6.11)
      await ds.undoLastMigration(); // deploy + checkpoints (6.5/6.9)
      await ds.undoLastMigration(); // billing (6.7/6.8)
      await ds.undoLastMigration(); // logs + investigations (6.4/6.6)
      await ds.undoLastMigration(); // intelligence (6.1-6.3)
      await ds.undoLastMigration(); // orchestration scope (H-05)
      await ds.undoLastMigration(); // center incidents (5.5)

      await ds.undoLastMigration(); // retention + compression (5.2)

      await ds.undoLastMigration(); // key rotation (5.1)

      await ds.undoLastMigration(); // client pairing
      await ds.undoLastMigration(); // git integration (3.5)
      await ds.undoLastMigration(); // orchestration (3.9)
      await ds.undoLastMigration(); // config sync (3.7)
      await ds.undoLastMigration(); // remote control (3.10)
      await ds.undoLastMigration(); // prompt templates (3.4)
      await ds.undoLastMigration(); // machine health (3.8)
      await ds.undoLastMigration(); // watchdog + reports (3.2/3.3)
      await ds.undoLastMigration(); // task queue (3.1)
      await ds.undoLastMigration();
      expect(await tables(ds)).not.toContain('approval_rules');
      expect(await tables(ds)).toContain('approvals');
      await ds.runMigrations();
      expect(await tables(ds)).toContain('approval_rules');
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('1.7 approvals migration', () => {
  it('table, constraints and indexes; down drops only the approvals table', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      const [m] = await ds.query(`INSERT INTO machines (slug, hostname) VALUES ('zz-ap', 'zz') RETURNING id`);
      const [dev] = await ds.query(`INSERT INTO devices (kind, name, token_hash, scopes) VALUES ('web', 'zz', 'h', '{approve}') RETURNING id`);
      const insert = (over: { status?: string; input?: string; hash?: string; resolved?: boolean; decided?: boolean } = {}) =>
        ds.query(
          `INSERT INTO approvals (id, machine_id, claude_session_id, cwd, tool_name, tool_input_redacted, tool_input_full_hash, status, deadline, resolved_at, decided_by_device_id, decided_at)
           VALUES (gen_random_uuid(), $1, 's', '/x', 'Bash', $2, $3, $4, now() + interval '5 minutes', $5, $6, $7)`,
          [m.id, over.input ?? '{}', over.hash ?? 'a'.repeat(64), over.status ?? 'pending', over.resolved ? new Date() : null, over.decided ? dev.id : null, over.decided ? new Date() : null],
        );
      await insert();
      await insert({ status: 'approved', resolved: true, decided: true });
      await insert({ status: 'expired', resolved: true });
      await expect(insert({ status: 'bogus', resolved: true })).rejects.toThrow(/chk_approvals_status/);
      await expect(insert({ input: 'x'.repeat(8193) })).rejects.toThrow(/chk_approvals_input_len/);
      await expect(insert({ hash: 'NOTHEX' })).rejects.toThrow(/chk_approvals_hash/);
      await expect(insert({ status: 'pending', resolved: true })).rejects.toThrow(/chk_approvals_resolved/); // pending <=> resolved_at NULL
      await expect(insert({ status: 'denied', resolved: true })).rejects.toThrow(/chk_approvals_decided/); // decided_by majburiy
      await expect(insert({ status: 'cancelled', resolved: true, decided: true })).rejects.toThrow(/chk_approvals_decided/);

      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)

      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)

      await ds.undoLastMigration(); // ask questions (6.13)

      await ds.undoLastMigration(); // weekly pace (6.12)
      await ds.undoLastMigration(); // scans + budgets (6.10/6.11)
      await ds.undoLastMigration(); // deploy + checkpoints (6.5/6.9)
      await ds.undoLastMigration(); // billing (6.7/6.8)
      await ds.undoLastMigration(); // logs + investigations (6.4/6.6)
      await ds.undoLastMigration(); // intelligence (6.1-6.3)
      await ds.undoLastMigration(); // orchestration scope (H-05)
      await ds.undoLastMigration(); // center incidents (5.5)

      await ds.undoLastMigration(); // retention + compression (5.2)

      await ds.undoLastMigration(); // key rotation (5.1)

      await ds.undoLastMigration(); // client pairing
      await ds.undoLastMigration(); // git integration (3.5)
      await ds.undoLastMigration(); // orchestration (3.9)
      await ds.undoLastMigration(); // config sync (3.7)
      await ds.undoLastMigration(); // remote control (3.10)
      await ds.undoLastMigration(); // prompt templates (3.4)
      await ds.undoLastMigration(); // machine health (3.8)
      await ds.undoLastMigration(); // watchdog + reports (3.2/3.3)
      await ds.undoLastMigration(); // task queue (3.1)

      await ds.undoLastMigration(); // approval rules (2.13/2.14)
      await ds.undoLastMigration(); // messaging (2.10)

      await ds.undoLastMigration(); // project work (2.15)
      await ds.undoLastMigration(); // project tasks (2.8/2.9)
      await ds.undoLastMigration(); // remote commands (2.3)
      await ds.undoLastMigration(); // permission_mode
      await ds.undoLastMigration(); // approvals
      expect(await tables(ds)).not.toContain('approvals');
      expect(await tables(ds)).toEqual(expect.arrayContaining(['sessions', 'devices', 'machines']));
      await ds.runMigrations();
      expect(await tables(ds)).toContain('approvals');
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('3.1 task queue migration', () => {
  it('CHECK: holat/rejim/tasdiq; run (queue_id, fire_seq) UNIQUE; down faqat o\'z jadvallarini o\'chiradi', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      const [m] = await ds.query(`INSERT INTO machines (slug) VALUES ('zz-tq') RETURNING id`);
      const [dev] = await ds.query(`INSERT INTO devices (kind, name, token_hash, scopes) VALUES ('web', 'zz', 'h-tq', '{control}') RETURNING id`);
      const ins = (status: string, mode: string, conf: string) =>
        ds.query(
          `INSERT INTO task_queue (id, machine_id, cwd, prompt_enc, prompt_len, prompt_preview, permission_mode, trigger, status, created_by_device_id, confirmation, confirmed_at)
           VALUES (gen_random_uuid(), $1, '/x', '\\x01', 1, 'p', $2, '{"type":"now"}', $3, $4, $5, now()) RETURNING id`,
          [m.id, mode, status, dev.id, conf],
        );
      const [ok] = await ins('queued', 'plan', 'exempt_device');
      await expect(ins('bogus', 'plan', 'exempt_device')).rejects.toThrow(/chk_task_queue_status/);
      await expect(ins('queued', 'bypassPermissions', 'exempt_device')).rejects.toThrow(/chk_task_queue_mode/);
      await expect(ins('queued', 'plan', 'nobody')).rejects.toThrow(/chk_task_queue_confirmation/);
      await ds.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, status) VALUES ($1, 1, 'starting')`, [ok.id]);
      await expect(ds.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, status) VALUES ($1, 1, 'starting')`, [ok.id])).rejects.toThrow(/uq_task_queue_runs_seq/);
      await expect(ds.query(`INSERT INTO task_queue_runs (queue_id, fire_seq, status) VALUES ($1, 2, 'weird')`, [ok.id])).rejects.toThrow(/chk_task_queue_runs_status/);
      await ds.query(`DELETE FROM task_queue WHERE id = $1`, [ok.id]);
      expect((await ds.query(`SELECT count(*)::int AS n FROM task_queue_runs`))[0].n).toBe(0); // CASCADE
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});

describe('3.9 orchestration migration', () => {
  it('CHECK: holat/origin/tasdiq/parallel/pozitsiya; (orkestratsiya, key) va (orkestratsiya, position) UNIQUE; qadamlar CASCADE; down faqat o\'z jadvallarini o\'chiradi', async () => {
    const db = await createThrowawayDb();
    const ds = await openDataSource(db.url);
    try {
      await ds.runMigrations();
      const ins = (status: string, origin: string, conf: string | null, conc = 3) =>
        ds.query(`INSERT INTO orchestrations (goal, group_key, status, origin, confirmation, token_budget, max_concurrent) VALUES ('g', 'k', $1, $2, $3, 1000, $4) RETURNING id`, [status, origin, conf, conc]);
      const [o] = await ins('running', 'lead', null);
      await expect(ins('bogus', 'lead', null)).rejects.toThrow(/chk_orch_status/);
      await expect(ins('running', 'robot', null)).rejects.toThrow(/chk_orch_origin/);
      await expect(ins('running', 'lead', 'nobody')).rejects.toThrow(/chk_orch_confirmation/);
      await expect(ins('running', 'lead', null, 9)).rejects.toThrow(/chk_orch_concurrent/);
      await expect(ds.query(`INSERT INTO orchestrations (goal, group_key, origin, token_budget) VALUES ('g', 'k', 'lead', 0)`)).rejects.toThrow(/chk_orch_budget/);
      const step = (key: string, pos: number, status = 'pending') =>
        ds.query(`INSERT INTO orchestration_steps (orchestration_id, key, position, title, role, status) VALUES ($1, $2, $3, 't', 'backend', $4)`, [o.id, key, pos, status]);
      await step('a', 0);
      await expect(step('a', 1)).rejects.toThrow(/uq_orch_steps_key/);
      await expect(step('b', 0)).rejects.toThrow(/uq_orch_steps_position/);
      await expect(step('c', 20)).rejects.toThrow(/chk_orch_steps_position/);
      await expect(step('d', 2, 'weird')).rejects.toThrow(/chk_orch_steps_status/);
      await ds.query(`DELETE FROM orchestrations WHERE id = $1`, [o.id]);
      expect((await ds.query(`SELECT count(*)::int AS n FROM orchestration_steps`))[0].n).toBe(0); // CASCADE
      await ds.undoLastMigration(); // daily summary part (6.18)
      await ds.undoLastMigration(); // project archive (6.16)
      await ds.undoLastMigration(); // project parts (6.15)
      await ds.undoLastMigration(); // backfill session model (no-op down)
      await ds.undoLastMigration(); // session resume (6.14)
      await ds.undoLastMigration(); // merge subfolder projects (no-op down)
      await ds.undoLastMigration(); // ask questions (6.13)
      await ds.undoLastMigration(); // weekly pace (6.12)
      await ds.undoLastMigration(); // scans + budgets (6.10/6.11)
      await ds.undoLastMigration(); // deploy + checkpoints (6.5/6.9)
      await ds.undoLastMigration(); // billing (6.7/6.8)
      await ds.undoLastMigration(); // logs + investigations (6.4/6.6)
      await ds.undoLastMigration(); // intelligence (6.1-6.3)
      await ds.undoLastMigration(); // orchestration scope (H-05)
      await ds.undoLastMigration(); // center incidents (5.5)
      await ds.undoLastMigration(); // retention + compression (5.2)
      await ds.undoLastMigration(); // key rotation (5.1)
      await ds.undoLastMigration(); // client pairing
      await ds.undoLastMigration();
      const t = (await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map((r: { table_name: string }) => r.table_name);
      expect(t).not.toContain('orchestrations');
      expect(t).not.toContain('orchestration_steps');
      expect(t).toContain('task_queue');
    } finally {
      await ds.destroy();
      await db.drop();
    }
  });
});
