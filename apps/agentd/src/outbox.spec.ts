import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@commander/contracts';
import { event, makeStores, usage } from '../test/helpers.js';

describe('Outbox', () => {
  it('ack kelguncha qoladi; ack qatorlarni o\'chiradi', () => {
    const { outbox } = makeStores();
    outbox.enqueueEvent(event());
    outbox.enqueueEvent(event());
    const batch = outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e6 });
    expect(batch).toHaveLength(2);
    // ack bo'lmagan: qayta so'ralsa o'sha qatorlar
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: 1e6 })).toHaveLength(2);
    outbox.ack(batch.map((r) => r.seq));
    expect(outbox.counts().events).toBe(0);
  });

  it("tartib saqlanadi va eventId o'zgarmaydi (retry'da ham)", () => {
    const { outbox } = makeStores();
    const e1 = event({ eventId: '11111111-1111-4111-8111-111111111111' });
    const e2 = event({ eventId: '22222222-2222-4222-8222-222222222222' });
    outbox.enqueueEvent(e1);
    outbox.enqueueEvent(e2);
    const first = outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e6 });
    outbox.retryAt(first.map((r) => r.seq), Date.now() - 1);
    const again = outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e6 });
    expect(again.map((r) => r.item.eventId)).toEqual([e1.eventId, e2.eventId]);
    expect(again[0]!.attempts).toBe(1);
  });

  it('dublikat eventId qayta qo\'shilmaydi', () => {
    const { outbox } = makeStores();
    const e = event();
    expect(outbox.enqueueEvent(e)).toBe(true);
    expect(outbox.enqueueEvent(e)).toBe(false);
    expect(outbox.counts().events).toBe(1);
  });

  it("retry: kutish vaqti kelmaguncha boshi bloklaydi (tartib buzilmaydi), clearRetryDelays tozalaydi", () => {
    let t = 1_000_000;
    const { outbox } = makeStores(() => t);
    outbox.enqueueEvent(event());
    outbox.enqueueEvent(event());
    const b = outbox.nextBatch('events', { maxItems: 1, maxBytes: 1e6 });
    outbox.retryAt(b.map((r) => r.seq), t + 5000);
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: 1e6 })).toHaveLength(0);
    expect(outbox.nextRetryAt('events')).toBe(t + 5000);
    t += 5001;
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: 1e6 })).toHaveLength(2);
    outbox.retryAt([b[0]!.seq], t + 99999);
    outbox.clearRetryDelays();
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: 1e6 })).toHaveLength(2);
  });

  it('batch maxItems va maxBytes bilan cheklanadi', () => {
    const { outbox } = makeStores();
    for (let i = 0; i < 5; i++) outbox.enqueueEvent(event());
    expect(outbox.nextBatch('events', { maxItems: 3, maxBytes: 1e6 })).toHaveLength(3);
    const size = outbox.nextBatch('events', { maxItems: 1, maxBytes: 1e6 })[0]!.size;
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: size * 2 + 1 })).toHaveLength(2);
    // bitta element maxBytes'dan katta bo'lsa ham kamida bittasi qaytadi (qotib qolmaslik uchun)
    expect(outbox.nextBatch('events', { maxItems: 100, maxBytes: 1 })).toHaveLength(1);
  });

  it("usage requestId bo'yicha dedup: ack'dan keyin ham (usage_seen)", () => {
    const { outbox } = makeStores();
    const u = usage({ requestId: 'req_dup' });
    expect(outbox.enqueueUsage(u)).toBe(true);
    const b = outbox.nextBatch('usage', { maxItems: 200, maxBytes: 1e6 });
    outbox.ack(b.map((r) => r.seq));
    expect(outbox.enqueueUsage({ ...u, source: 'transcript', ts: u.ts + 5 })).toBe(false);
    expect(outbox.hasSeenUsage('req_dup')).toBe(true);
    expect(outbox.counts().usage).toBe(0);
  });

  it("turlar alohida: events/usage/limits bir-biriga to'sqinlik qilmaydi", () => {
    const { outbox } = makeStores();
    outbox.enqueueEvent(event());
    outbox.enqueueUsage(usage());
    outbox.enqueueLimits({ observedAt: 1, sevenDay: { usedPct: 1, resetsAt: 2 } });
    expect(outbox.counts()).toEqual({ events: 1, usage: 1, limits: 1, projects: 0 });
    outbox.drop(outbox.nextBatch('events', { maxItems: 9, maxBytes: 1e6 }).map((r) => r.seq));
    expect(outbox.counts()).toEqual({ events: 0, usage: 1, limits: 1, projects: 0 });
  });

  it("prune: eskirgan usage tashlanadi, qatorlar soni chegaralanadi (eng eskilari ketadi)", () => {
    const now = Date.now();
    const { outbox } = makeStores(() => now, { maxRows: { events: 3, usage: 100, limits: 100, projects: 100 }, usageMaxAgeDays: 7 });
    outbox.enqueueUsage(usage({ ts: now - 8 * 24 * 3600 * 1000 }));
    outbox.enqueueUsage(usage({ ts: now - 1000 }));
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = event();
      ids.push(e.eventId);
      outbox.enqueueEvent(e);
    }
    const dropped = outbox.prune();
    expect(dropped).toBe(1 + 3);
    expect(outbox.counts()).toEqual({ events: 3, usage: 1, limits: 0, projects: 0 });
    expect(outbox.nextBatch<AgentEvent>('events', { maxItems: 9, maxBytes: 1e6 }).map((r) => r.item.eventId)).toEqual(ids.slice(3));
  });

  it('qayta ochilganda (restart) saqlanadi', async () => {
    const { tmpHome } = await import('../test/helpers.js');
    const { openDb } = await import('./db.js');
    const { Outbox } = await import('./outbox.js');
    const { silentLogger } = await import('./logger.js');
    const h = tmpHome();
    try {
      const e = event();
      const db1 = openDb(`${h.dir}/o.db`);
      new Outbox(db1, silentLogger).enqueueEvent(e);
      db1.close();
      const db2 = openDb(`${h.dir}/o.db`);
      const rows = new Outbox(db2, silentLogger).nextBatch<AgentEvent>('events', { maxItems: 9, maxBytes: 1e6 });
      expect(rows.map((r) => r.item.eventId)).toEqual([e.eventId]);
      db2.close();
    } finally {
      h.cleanup();
    }
  });
});
