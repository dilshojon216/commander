import { describe, expect, it } from 'vitest';
import {
  AgentHealthMessageSchema,
  AgentHealthPayloadSchema,
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_LIMITS,
  HealthThresholdsPatchSchema,
  HealthThresholdsSchema,
  HealthQuerySchema,
  PutHealthThresholdsBodySchema,
  createEnvelope,
} from './index.js';

const base = {
  collectedAt: 1_700_000_000_000,
  platform: 'linux',
  cpu: { pct: 10, cores: 4 },
  memory: { totalBytes: 100, usedBytes: 50, swapTotalBytes: 0, swapUsedBytes: 0 },
  uptimeSec: 5,
};

describe('agent.health kontrakti', () => {
  it('delta: faqat umumiy maydonlar yetarli; full: disks va topProcesses shart', () => {
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta' }).success).toBe(true);
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'full' }).success).toBe(false);
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'full', disks: [], topProcesses: { byCpu: [], byMem: [] } }).success).toBe(true);
  });
  it('chegaralar: 10 disk, 5 jarayon, 100 konteyner', () => {
    const disk = { mount: '/', totalBytes: 1, usedBytes: 1, pct: 100 };
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', disks: Array(11).fill(disk) }).success).toBe(false);
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', disks: Array(HEALTH_LIMITS.maxDisks).fill(disk) }).success).toBe(true);
    const proc = { name: 'a', cpuPct: 1, memPct: 1 };
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', topProcesses: { byCpu: Array(6).fill(proc), byMem: [] } }).success).toBe(false);
    const c = { name: 'a', image: 'i', state: 'running', status: 'Up', restartCount: 0, health: 'none' };
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', docker: { available: true, containers: Array(101).fill(c) } }).success).toBe(false);
  });
  it('xavfli qiymatlar rad etiladi (foiz > 100, manfiy bayt, noma\'lum health)', () => {
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', cpu: { pct: 101, cores: 1 } }).success).toBe(false);
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', memory: { ...base.memory, usedBytes: -1 } }).success).toBe(false);
    expect(AgentHealthPayloadSchema.safeParse({ ...base, kind: 'delta', docker: { available: true, containers: [{ name: 'a', image: 'i', state: 's', status: '', restartCount: 0, health: 'weird' }] } }).success).toBe(false);
  });
  it('envelope', () => {
    expect(AgentHealthMessageSchema.safeParse(createEnvelope('agent.health', { ...base, kind: 'delta' })).success).toBe(true);
  });
});

describe('chegaralar kontrakti', () => {
  it('sukut qiymatlari ADR bilan mos', () => {
    expect(HealthThresholdsSchema.parse(DEFAULT_HEALTH_THRESHOLDS)).toEqual({
      diskWarnPct: 85, diskCriticalPct: 95, memPct: 90, memForMin: 5, cpuPct: 95, cpuForMin: 10, restartLoopCount: 3, restartLoopWindowMin: 10, offlineAfterMin: 10,
    });
  });
  it('patch qat\'iy: noma\'lum kalit rad; PUT body null override', () => {
    expect(HealthThresholdsPatchSchema.safeParse({ diskWarnPct: 80, foo: 1 }).success).toBe(false);
    expect(PutHealthThresholdsBodySchema.safeParse({ machines: { '11111111-1111-4111-8111-111111111111': null } }).success).toBe(true);
    expect(PutHealthThresholdsBodySchema.safeParse({ machines: { nope: {} } }).success).toBe(false);
  });
  it('range', () => {
    expect(HealthQuerySchema.parse({}).range).toBe('24h');
    expect(HealthQuerySchema.safeParse({ range: '30d' }).success).toBe(false);
  });
});
