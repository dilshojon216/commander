import type { UsageTickPayload } from '@commander/contracts';
import type { UsageDelta } from './realtime-bus.js';

type Bucket = UsageTickPayload['total'];

const empty = (): Bucket => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, requests: 0 });

function add(b: Bucket, d: UsageDelta): void {
  b.inputTokens += d.inputTokens;
  b.outputTokens += d.outputTokens;
  b.cacheReadTokens += d.cacheReadTokens;
  b.cacheCreationTokens += d.cacheCreationTokens;
  b.requests += 1;
  if (d.costUsd !== null) b.costUsd = (b.costUsd ?? 0) + d.costUsd;
}

/** `usage.tick` uchun delta yig'uvchi (sof): `add()` ketma-ket chaqiriladi, `flush()` jamlangan payload qaytaradi va tozalaydi. */
export class UsageTickAccumulator {
  private total = empty();
  private readonly machines = new Map<string, Bucket>();
  private readonly projects = new Map<string | null, Bucket>();
  private from: number | null = null;

  get pending(): boolean {
    return this.from !== null;
  }

  add(rows: readonly UsageDelta[], now: number): void {
    if (rows.length === 0) return;
    this.from ??= now;
    for (const r of rows) {
      add(this.total, r);
      add(this.machines.get(r.machineId) ?? this.set(this.machines, r.machineId), r);
      add(this.projects.get(r.projectId) ?? this.set(this.projects, r.projectId), r);
    }
  }

  private set<K>(m: Map<K, Bucket>, k: K): Bucket {
    const b = empty();
    m.set(k, b);
    return b;
  }

  flush(now: number): UsageTickPayload | null {
    if (this.from === null) return null;
    const payload: UsageTickPayload = {
      from: this.from,
      to: now,
      total: this.total,
      byMachine: [...this.machines].map(([machineId, b]) => ({ machineId, ...b })),
      byProject: [...this.projects].map(([projectId, b]) => ({ projectId, ...b })),
    };
    this.total = empty();
    this.machines.clear();
    this.projects.clear();
    this.from = null;
    return payload;
  }
}
