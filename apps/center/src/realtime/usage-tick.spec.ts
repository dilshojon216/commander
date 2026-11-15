import { describe, expect, it } from 'vitest';
import { UsageTickAccumulator } from './usage-tick.js';
import { RealtimeBus } from './realtime-bus.js';
import type { DomainEvent, UsageDelta } from './realtime-bus.js';

const d = (over: Partial<UsageDelta> = {}): UsageDelta => ({ machineId: 'm1', projectId: 'p1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 1, costUsd: 0.5, ...over });

describe('UsageTickAccumulator', () => {
  it('is empty until something is added; flush returns null', () => {
    const a = new UsageTickAccumulator();
    expect(a.pending).toBe(false);
    expect(a.flush(1)).toBeNull();
    a.add([], 5);
    expect(a.pending).toBe(false);
  });

  it('aggregates deltas into total, by machine and by project, then resets', () => {
    const a = new UsageTickAccumulator();
    a.add([d(), d({ machineId: 'm2', projectId: null, costUsd: null })], 1000);
    a.add([d()], 1500);
    const p = a.flush(2000)!;
    expect(p.from).toBe(1000);
    expect(p.to).toBe(2000);
    expect(p.total).toEqual({ inputTokens: 30, outputTokens: 15, cacheReadTokens: 300, cacheCreationTokens: 3, costUsd: 1, requests: 3 });
    expect(p.byMachine.find((m) => m.machineId === 'm1')).toMatchObject({ inputTokens: 20, requests: 2, costUsd: 1 });
    expect(p.byMachine.find((m) => m.machineId === 'm2')).toMatchObject({ requests: 1, costUsd: null });
    expect(p.byProject.find((x) => x.projectId === null)?.requests).toBe(1);
    expect(a.pending).toBe(false);
    expect(a.flush(3000)).toBeNull();
  });
});

describe('RealtimeBus', () => {
  it('delivers to all listeners, isolates listener failures, supports unsubscribe', async () => {
    const bus = new RealtimeBus();
    const got: DomainEvent[] = [];
    const off = bus.subscribe((e) => void got.push(e));
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.publish({ type: 'limits.changed' });
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([{ type: 'limits.changed' }]);
    off();
    bus.publish({ type: 'limits.changed' });
    expect(got).toHaveLength(1);
  });
});
