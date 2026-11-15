import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LimitWindowViewSchema,
  LimitsResponseSchema,
  ListProjectsQuerySchema,
  ListProjectsResponseSchema,
  ProjectDtoSchema,
  ListSessionEventsQuerySchema,
  ListSessionsQuerySchema,
  MachineDtoSchema,
  SessionDtoSchema,
  USAGE_RANGE_LIMITS_MS,
  UsageQuerySchema,
  UsageResponseSchema,
  UsageSummaryResponseSchema,
  isQueryFlagTrue,
} from './index.js';

describe('GET /v1/sessions query', () => {
  it('defaults limit to 100, coerces numbers, validates status/active flags', () => {
    expect(ListSessionsQuerySchema.parse({}).limit).toBe(100);
    expect(ListSessionsQuerySchema.parse({ limit: '25', status: 'working', active: '1' })).toMatchObject({ limit: 25, status: 'working', active: '1' });
    expect(ListSessionsQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ status: 'stale' }).success).toBe(false); // stale holat emas
    expect(ListSessionsQuerySchema.safeParse({ active: 'yes' }).success).toBe(false);
    expect(ListSessionsQuerySchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('query flags', () => {
    expect(isQueryFlagTrue('1')).toBe(true);
    expect(isQueryFlagTrue('true')).toBe(true);
    expect(isQueryFlagTrue('0')).toBe(false);
    expect(isQueryFlagTrue(undefined)).toBe(false);
  });

  it('events and projects queries are bounded and strict', () => {
    expect(ListSessionEventsQuerySchema.parse({}).limit).toBe(100);
    expect(ListSessionEventsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(ListProjectsQuerySchema.parse({}).limit).toBe(200);
    expect(ListProjectsQuerySchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('GET /v1/usage query', () => {
  it('defaults: bucket 1h, groupBy none', () => {
    expect(UsageQuerySchema.parse({})).toEqual({ bucket: '1h', groupBy: 'none' });
  });

  it('accepts ISO ranges with offsets and every bucket/groupBy', () => {
    const q = UsageQuerySchema.parse({ bucket: '1d', groupBy: 'project', from: '2026-11-01T00:00:00+05:00', to: '2026-11-13T00:00:00Z', project: randomUUID() });
    expect(q.bucket).toBe('1d');
    for (const bucket of ['5m', '1h', '1d']) for (const groupBy of ['none', 'project', 'machine', 'model']) expect(UsageQuerySchema.safeParse({ bucket, groupBy }).success).toBe(true);
  });

  it('rejects bad bucket, bad groupBy, non-ISO dates and a non-uuid project', () => {
    for (const bad of [{ bucket: '10m' }, { groupBy: 'user' }, { from: 'yesterday' }, { to: '2026-11-13' }, { project: 'x' }, { extra: 1 }]) {
      expect(UsageQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('range limits per bucket are sane and increasing', () => {
    expect(USAGE_RANGE_LIMITS_MS['5m'].max).toBeLessThan(USAGE_RANGE_LIMITS_MS['1h'].max);
    expect(USAGE_RANGE_LIMITS_MS['1h'].max).toBeLessThan(USAGE_RANGE_LIMITS_MS['1d'].max);
    for (const l of Object.values(USAGE_RANGE_LIMITS_MS)) expect(l.default).toBeLessThanOrEqual(l.max);
  });
});

const totals = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, totalTokens: 10, costUsd: null, requests: 1 };

describe('response shapes', () => {
  it('usage response', () => {
    const r = {
      bucket: '1h', from: '2026-11-13T00:00:00.000Z', to: '2026-11-13T06:00:00.000Z', groupBy: 'machine', timezone: 'Asia/Tashkent', source: 'usage_1h',
      series: [{ key: randomUUID(), label: 'mac', points: [{ t: '2026-11-13T00:00:00.000Z', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, requests: 1 }], total: totals }],
    };
    expect(UsageResponseSchema.safeParse(r).success).toBe(true);
    expect(UsageResponseSchema.safeParse({ ...r, source: 'magic' }).success).toBe(false);
  });

  it('usage summary always labels cost as api_equivalent and the timezone', () => {
    const p = { from: null, totals };
    const r = { today: p, last7d: p, last30d: p, allTime: p, timezone: 'Asia/Tashkent', costKind: 'api_equivalent' };
    expect(UsageSummaryResponseSchema.safeParse(r).success).toBe(true);
    expect(UsageSummaryResponseSchema.safeParse({ ...r, costKind: 'real' }).success).toBe(false);
  });

  const window = {
    usedPct: 40, resetsAt: '2026-11-13T13:00:00.000Z', observedAt: '2026-11-13T10:00:00.000Z', source: 'official', stale: false, ageSeconds: 5, reset: false,
    observedByMachineId: randomUUID(), anchor: { usedPct: 40, resetsAt: '2026-11-13T13:00:00.000Z', observedAt: '2026-11-13T10:00:00.000Z' }, calibration: { coefficient: null, samples: 0 },
  };

  it('limit window: source is official|estimate only (CLAUDE.md #6)', () => {
    expect(LimitWindowViewSchema.safeParse(window).success).toBe(true);
    expect(LimitWindowViewSchema.safeParse({ ...window, source: 'estimate', reset: true, resetsAt: null }).success).toBe(true);
    expect(LimitWindowViewSchema.safeParse({ ...window, source: 'guess' }).success).toBe(false);
    expect(LimitWindowViewSchema.safeParse({ ...window, source: undefined }).success).toBe(false);
  });

  it('limits response allows a missing window (never observed)', () => {
    expect(LimitsResponseSchema.safeParse({ computedAt: '2026-11-13T10:00:00.000Z', freshSeconds: 180, fiveHour: null, sevenDay: window }).success).toBe(true);
  });

  it('machine and session DTOs', () => {
    const machine = {
      id: randomUUID(), slug: 'mac', displayName: null, hostname: 'h', os: 'darwin', online: true, lastSeenAt: null, connectedAt: null, disconnectedAt: null,
      agentdVersion: '0.1.0', claudeVersion: '2.1.304', identityStatus: 'verified',
      sessions: { open: 1, working: 1, waiting: 0, awaitingApproval: 0, idle: 0, done: 0 }, control: null,
    };
    expect(MachineDtoSchema.safeParse(machine).success).toBe(true);
    const session = {
      id: randomUUID(), claudeSessionId: 's', machineId: machine.id, machineSlug: 'mac', machineName: 'mac', projectId: null, projectName: 'commander', cwd: '/x', name: null, kind: 'interactive',
      status: 'awaiting_approval', message: null, notificationType: null, model: null, permissionMode: 'plan', startedAt: '2026-11-13T10:00:00.000Z', statusSince: '2026-11-13T10:00:00.000Z',
      lastSeenAt: '2026-11-13T10:00:00.000Z', endedAt: null, endReason: null, staleSince: null, pendingApprovals: 1,
      controllable: false, controlReason: 'interactive', controls: { prompt: false, stop: true, setMode: false },
    };
    expect(SessionDtoSchema.safeParse(session).success).toBe(true);
    expect(SessionDtoSchema.safeParse({ ...session, status: 'stale' }).success).toBe(false);
    expect(SessionDtoSchema.safeParse({ ...session, controlReason: 'because' }).success).toBe(false);
  });
});

describe('6.16 loyiha arxivi', () => {
  it('archived query: faqat bayroq qiymatlari', () => {
    expect(ListProjectsQuerySchema.parse({ archived: '1' }).archived).toBe('1');
    expect(ListProjectsQuerySchema.parse({}).archived).toBeUndefined();
    expect(ListProjectsQuerySchema.safeParse({ archived: 'yes' }).success).toBe(false);
  });

  it('eski center javobi (archivedAt/archived yo\'q) ham o\'qiladi: faol, arxiv bo\'sh', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null, requests: 0 };
    const project = {
      id: randomUUID(), machineId: randomUUID(), machineSlug: 'm', name: 'p', path: '/p', repoKey: null, kind: 'git', today: zero, allTime: zero,
      firstUsedAt: null, lastUsedAt: null, openSessions: 0,
    };
    expect(ProjectDtoSchema.parse(project).archivedAt).toBeNull();
    const list = ListProjectsResponseSchema.parse({ items: [project], unattributed: { today: zero, allTime: zero }, todayStart: '2026-11-13T00:00:00.000Z', timezone: 'Asia/Tashkent' });
    expect(list.archived.count).toBe(0);
    expect(list.archived.todayByMachine).toEqual([]);
    expect(ProjectDtoSchema.parse({ ...project, archivedAt: '2026-11-14T00:00:00.000Z' }).archivedAt).toBe('2026-11-14T00:00:00.000Z');
  });
});
