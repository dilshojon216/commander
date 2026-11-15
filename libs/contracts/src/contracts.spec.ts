import { describe, expect, it } from 'vitest';
import {
  CreateEventBodySchema,
  ListSessionEventsResponseSchema,
  ListSessionsResponseSchema,
  SESSION_STATUSES,
  isSessionStatus,
} from './index.js';

describe('contracts', () => {
  it('status enum is the v0 set plus awaiting_approval', () => {
    expect([...SESSION_STATUSES]).toEqual(['idle', 'working', 'waiting', 'awaiting_approval', 'done', 'ended']);
    expect(isSessionStatus('working')).toBe(true);
    expect(isSessionStatus('nope')).toBe(false);
  });

  it('accepts a valid POST /events body and rejects a bad status', () => {
    const ok = {
      host: 'mac', session_id: 's1', cwd: '/x', event: 'Stop', status: 'done', ts: 1,
    };
    expect(CreateEventBodySchema.safeParse(ok).success).toBe(true);
    expect(CreateEventBodySchema.safeParse({ ...ok, status: 'bad' }).success).toBe(false);
    expect(CreateEventBodySchema.safeParse({ ...ok, message: null, notification_type: null }).success).toBe(true);
  });

  it('parses session list and event list shapes', () => {
    const s = {
      host: 'h', session_id: 'a', cwd: '/c', project: 'c', status: 'idle', message: null,
      notification_type: null, started_at: '2026-01-01T00:00:00.000Z',
      status_since: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-01-01T00:00:00.000Z', ended_at: null,
    };
    expect(ListSessionsResponseSchema.parse([s])).toHaveLength(1);
    const e = {
      id: '1', host: 'h', session_id: 'a', event: 'Stop', status: 'done', message: null,
      client_ts: 5, received_at: '2026-01-01T00:00:00.000Z',
    };
    expect(ListSessionEventsResponseSchema.parse([e])).toHaveLength(1);
  });
});

import {
  EnrollRequestSchema,
  buildCanonicalString,
  canonicalQuery,
  ListAuditQuerySchema,
} from './index.js';

describe('identity contracts', () => {
  const enroll = {
    code: 'ABCD-EFGH',
    public_key: 'A'.repeat(43),
    hardware_id: 'hw-1234567890',
    hostname: 'mac',
    os: 'darwin',
    arch: 'arm64',
  };

  it('enroll request: accepts raw key, rejects SPKI-length key and unknown fields', () => {
    expect(EnrollRequestSchema.safeParse(enroll).success).toBe(true);
    expect(EnrollRequestSchema.safeParse({ ...enroll, public_key: 'A'.repeat(59) }).success).toBe(false);
    expect(EnrollRequestSchema.safeParse({ ...enroll, spki: 'x' }).success).toBe(false);
  });

  it('canonical query is sorted and ignores empty parts', () => {
    expect(canonicalQuery('b=2&&a=1&a=0')).toBe('a=0&a=1&b=2');
    expect(canonicalQuery('')).toBe('');
  });

  it('canonical string layout is stable', () => {
    const s = buildCanonicalString({
      method: 'get', path: '/v1/devices/me', rawQuery: 'b=1&a=2', bodySha256: 'AB'.repeat(32),
      timestamp: '1767261600000', nonce: 'n'.repeat(16), deviceId: 'dev',
    });
    expect(s.split('\n')).toEqual([
      'COMMANDER-SIG-V1', 'GET', '/v1/devices/me', 'a=2&b=1', 'ab'.repeat(32), '1767261600000', 'n'.repeat(16), 'dev',
    ]);
  });

  it('audit list query applies defaults and bounds', () => {
    expect(ListAuditQuerySchema.parse({}).limit).toBe(50);
    expect(ListAuditQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});
