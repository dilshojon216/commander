import { describe, expect, it } from 'vitest';
import { ASK_LIMITS } from '@commander/contracts';
import { buildAskContext, pickAssistantMachine, resolveSources } from './ask-context.js';
import type { AskFacts } from './ask-context.js';

const SECRET = 'sk-ant-api03-SUPERSECRETVALUE1234567890abcdef';
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function facts(over: Partial<AskFacts> = {}): AskFacts {
  return {
    now: new Date('2026-11-14T10:00:00Z'),
    machines: [{ id: U(1), name: 'mac-mini', online: true, openSessions: 2, working: 1, waiting: 1, awaitingApproval: 0, lastSeenMinutesAgo: 0 }],
    sessions: [{ id: U(2), project: 'api', machine: 'mac-mini', status: 'working', task: '6.1', sinceMinutes: 4 }],
    projects: [{ id: U(3), name: 'api', machine: 'mac-mini', todayTokens: 120_000, openSessions: 1, tasks: { todo: 3, doing: 1, done: 7 } }],
    usage: { todayTokens: 500_000, last7dTokens: 3_000_000, last30dTokens: 9_000_000, todayCostUsd: 12.5, last7dCostUsd: null },
    limits: { fiveHour: { usedPct: 41.2, source: 'estimate', resetsAt: '2026-11-14T12:00:00Z' }, sevenDay: { usedPct: 10, source: 'official', resetsAt: null } },
    queue: [{ status: 'waiting', count: 2 }],
    reports: [{ id: U(4), kind: 'daily', periodStart: '2026-11-13', text: 'Kecha 3 vazifa bajarildi' }],
    summaries: [{ sessionId: U(5), project: 'api', machine: 'mac-mini', taskKey: '6.1', createdAt: '2026-11-13T09:00:00Z', summary: 'Login tuzatildi', done: ['fix'], openItems: ['test'] }],
    decisions: [{ id: U(6), projectId: U(3), project: 'api', title: 'Redis kesh', decision: 'Redis ishlatamiz', createdAt: '2026-11-01T00:00:00Z' }],
    ...over,
  };
}

describe('buildAskContext', () => {
  it('contains structured facts with a source catalog and marks estimates as estimates', () => {
    const { context, catalog } = buildAskContext(facts());
    expect(context).toContain('mac-mini');
    expect(context).toContain('Login tuzatildi');
    expect(context).toContain('≈ 41%');
    expect(context).toContain('TAXMIN');
    expect(context).toContain('(rasmiy)');
    expect(context).toContain('API ekvivalenti');
    const session = [...catalog.values()].find((s) => s.kind === 'session' && s.id === U(5));
    expect(session?.href).toBe(`/sessions/${U(5)}`);
    expect([...catalog.values()].every((s) => s.href === null || /^\/(sessions|projects|machines|reports)\/[0-9a-f-]{36}$|^\/(queue|usage)$/.test(s.href))).toBe(true);
  });

  it('NEVER renders transcript/prompt-like fields even if a caller passes them (explicit field picking)', () => {
    const dirty = facts();
    (dirty.summaries[0] as unknown as Record<string, unknown>)['transcript'] = 'XOM TRANSCRIPT MATNI';
    (dirty.sessions[0] as unknown as Record<string, unknown>)['prompt'] = 'FOYDALANUVCHI PROMPTI';
    (dirty.machines[0] as unknown as Record<string, unknown>)['chatText'] = 'CHAT MATNI';
    (dirty.projects[0] as unknown as Record<string, unknown>)['toolInput'] = 'TOOL KIRITMASI';
    const { context } = buildAskContext(dirty);
    for (const leak of ['XOM TRANSCRIPT', 'FOYDALANUVCHI PROMPTI', 'CHAT MATNI', 'TOOL KIRITMASI']) expect(context).not.toContain(leak);
  });

  it('redacts secrets that slipped into free text', () => {
    const { context } = buildAskContext(facts({ summaries: [{ sessionId: U(5), project: 'api', machine: 'm', taskKey: null, createdAt: '2026-11-13T09:00:00Z', summary: `kalit ${SECRET} topildi`, done: [], openItems: [] }] }));
    expect(context).not.toContain('SUPERSECRETVALUE');
    expect(context).toContain('[REDACTED]');
  });

  it('stays within the size cap by shrinking summaries first', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ sessionId: U(100 + i), project: 'api', machine: 'm', taskKey: null, createdAt: '2026-11-13T09:00:00Z', summary: 'x'.repeat(700), done: ['d'.repeat(60)], openItems: [] }));
    const { context } = buildAskContext(facts({ summaries: many }), 3000);
    expect(context.length).toBeLessThanOrEqual(3000);
    expect(buildAskContext(facts({ summaries: many })).context.length).toBeLessThanOrEqual(ASK_LIMITS.contextMaxChars);
  });
});

describe('resolveSources / pickAssistantMachine', () => {
  it('keeps only catalog ids, deduped, in order', () => {
    const { catalog } = buildAskContext(facts());
    const r = resolveSources(['S1', 'S1', 'S999', 'S2'], catalog);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(catalog.get('S1'));
  });

  it('prefers the configured machine, then an online Mac, then any ready machine; never an unready one', () => {
    const rows = [
      { id: 'a', online: true, os: 'linux', assistant: true, lastSeenAt: 3 },
      { id: 'b', online: true, os: 'darwin', assistant: true, lastSeenAt: 1 },
      { id: 'c', online: true, os: 'darwin', assistant: false, lastSeenAt: 9 },
      { id: 'd', online: false, os: 'darwin', assistant: true, lastSeenAt: 9 },
    ];
    expect(pickAssistantMachine(rows, 'a')?.id).toBe('a');
    expect(pickAssistantMachine(rows, 'd')?.id).toBe('b');
    expect(pickAssistantMachine(rows, null)?.id).toBe('b');
    expect(pickAssistantMachine(rows.filter((r) => r.os === 'linux'), null)?.id).toBe('a');
    expect(pickAssistantMachine(rows.filter((r) => r.id === 'c' || r.id === 'd'), null)).toBeNull();
  });
});
