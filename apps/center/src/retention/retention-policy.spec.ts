import { describe, expect, it } from 'vitest';
import { CAGG_SOURCES, HYPERTABLE_POLICIES, SWEEP_PROC, checkRetentionInvariants, parseIntervalDays } from './retention-policy.js';
import type { JobRow } from './retention-policy.js';

function goodJobs(): JobRow[] {
  const jobs: JobRow[] = [{ proc_name: SWEEP_PROC, target: null, config: null }];
  for (const [t, p] of Object.entries(HYPERTABLE_POLICIES)) {
    jobs.push({ proc_name: 'policy_retention', target: t, config: { drop_after: `${p.dropAfterDays} days` } });
    if (p.compressAfterDays !== null) jobs.push({ proc_name: 'policy_compression', target: t, config: { compress_after: `${p.compressAfterDays} days` } });
  }
  const starts: Record<string, string> = { usage_5m: '7 days', usage_1h: '29 days', token_usage_daily_by_project: '25 days', machine_health_5m: '3 days' };
  for (const c of Object.keys(CAGG_SOURCES)) jobs.push({ proc_name: 'policy_refresh_continuous_aggregate', target: c, config: { start_offset: starts[c]! } });
  return jobs;
}

describe('parseIntervalDays', () => {
  it('parses Postgres interval spellings', () => {
    expect(parseIntervalDays('30 days')).toBe(30);
    expect(parseIntervalDays('1 day')).toBe(1);
    expect(parseIntervalDays('7 days 00:00:00')).toBe(7);
    expect(parseIntervalDays('168:00:00')).toBe(7);
    expect(parseIntervalDays('1 mon')).toBe(30);
    expect(parseIntervalDays('garbage')).toBeNull();
    expect(parseIntervalDays(undefined)).toBeNull();
  });
});

describe('checkRetentionInvariants', () => {
  it('the documented setup passes', () => {
    expect(checkRetentionInvariants(goodJobs())).toEqual([]);
  });

  it('documents the required numbers', () => {
    expect(HYPERTABLE_POLICIES['session_events']).toEqual({ dropAfterDays: 90, compressAfterDays: 7 });
    expect(HYPERTABLE_POLICIES['token_usage']).toEqual({ dropAfterDays: 30, compressAfterDays: 7 });
    expect(HYPERTABLE_POLICIES['machine_health']?.dropAfterDays).toBe(14);
    expect(HYPERTABLE_POLICIES['limit_samples']?.dropAfterDays).toBe(180);
  });

  it('flags a missing retention/compression policy and a wrong window', () => {
    const jobs = goodJobs().filter((j) => !(j.proc_name === 'policy_retention' && j.target === 'limit_samples')).filter((j) => !(j.proc_name === 'policy_compression' && j.target === 'token_usage'));
    const p = checkRetentionInvariants(jobs);
    expect(p).toContain("limit_samples: retention policy yo'q");
    expect(p).toContain("token_usage: compression policy yo'q");
    const wrong = goodJobs().map((j) => (j.proc_name === 'policy_retention' && j.target === 'session_events' ? { ...j, config: { drop_after: '60 days' } } : j));
    expect(checkRetentionInvariants(wrong)).toContain('session_events: retention 60 kun (kutilgan 90)');
  });

  it('flags a cagg refresh window that would destroy materialized days when raw is dropped', () => {
    const bad = goodJobs().map((j) => (j.target === 'token_usage_daily_by_project' && j.proc_name === 'policy_refresh_continuous_aggregate' ? { ...j, config: { start_offset: '31 days' } } : j));
    expect(checkRetentionInvariants(bad).some((m) => m.includes('token_usage_daily_by_project') && m.includes('start_offset'))).toBe(true);
  });

  it('flags retention on a continuous aggregate (all-time stats must stay) and a missing sweep job', () => {
    const bad = [...goodJobs(), { proc_name: 'policy_retention', target: 'usage_1h', config: { drop_after: '90 days' } }].filter((j) => j.proc_name !== SWEEP_PROC);
    const p = checkRetentionInvariants(bad);
    expect(p.some((m) => m.startsWith('usage_1h:') && m.includes('retention'))).toBe(true);
    expect(p.some((m) => m.includes(SWEEP_PROC))).toBe(true);
  });

  it('flags compress_after >= drop_after', () => {
    const bad = goodJobs().map((j) => (j.proc_name === 'policy_compression' && j.target === 'machine_health' ? { ...j, config: { compress_after: '20 days' } } : j));
    expect(checkRetentionInvariants(bad).some((m) => m.startsWith('machine_health: compress_after'))).toBe(true);
  });
});
