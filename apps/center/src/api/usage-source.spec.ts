import { describe, expect, it } from 'vitest';
import { selectUsageSource, validateRange } from './usage-source.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const none = { machine: false, project: false };

describe('selectUsageSource', () => {
  it('uses the fine-grained caggs when project is not needed', () => {
    expect(selectUsageSource('5m', 'none', none).source).toBe('usage_5m');
    expect(selectUsageSource('5m', 'machine', none).source).toBe('usage_5m');
    expect(selectUsageSource('1h', 'model', none).source).toBe('usage_1h');
    expect(selectUsageSource('1h', 'none', { machine: true, project: false }).source).toBe('usage_1h');
  });

  it('falls back to raw token_usage when a project dimension is needed at 5m/1h (caggs have no project)', () => {
    expect(selectUsageSource('5m', 'project', none).source).toBe('raw');
    expect(selectUsageSource('1h', 'none', { machine: false, project: true }).source).toBe('raw');
  });

  it('daily: project/model/none -> daily_by_project, machine -> usage_1h re-bucketed to Tashkent days, both -> raw', () => {
    expect(selectUsageSource('1d', 'project', none)).toEqual({ source: 'daily_by_project', rebucketDaily: false });
    expect(selectUsageSource('1d', 'model', none).source).toBe('daily_by_project');
    expect(selectUsageSource('1d', 'none', { machine: false, project: true }).source).toBe('daily_by_project');
    expect(selectUsageSource('1d', 'machine', none)).toEqual({ source: 'usage_1h', rebucketDaily: true });
    expect(selectUsageSource('1d', 'none', { machine: true, project: false })).toEqual({ source: 'usage_1h', rebucketDaily: true });
    expect(selectUsageSource('1d', 'machine', { machine: false, project: true }).source).toBe('raw');
  });
});

describe('validateRange', () => {
  const t = (s: string) => new Date(s);
  it('rejects empty/inverted and too-long ranges', () => {
    expect(validateRange(t('2026-01-02T00:00:00Z'), t('2026-01-01T00:00:00Z'), 1e9)).toMatch(/earlier/);
    expect(validateRange(t('2026-01-01T00:00:00Z'), t('2026-01-01T00:00:00Z'), 1e9)).toMatch(/earlier/);
    expect(validateRange(t('2026-01-01T00:00:00Z'), t('2026-03-01T00:00:00Z'), 86_400_000)).toMatch(/too long/);
    expect(validateRange(t('2026-01-01T00:00:00Z'), t('2026-01-01T06:00:00Z'), 86_400_000)).toBeNull();
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage / bad timestamps', () => {
    const c = { ts: '2026-11-13T10:00:00.123456Z', id: '0d9e6c0a-9d3c-4f6a-8e0f-1a2b3c4d5e6f' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify(['2026-11-13', 'x'])).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ a: 1 })).toString('base64url'))).toBeNull();
  });
});
