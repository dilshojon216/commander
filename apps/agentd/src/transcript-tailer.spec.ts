import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '@commander/contracts';
import { makeStores, tmpHome, usage } from '../test/helpers.js';
import { silentLogger } from './logger.js';
import { OTEL_GRACE_MS, SETTLE_MS, TranscriptTailer } from './transcript-tailer.js';

const homes: Array<() => void> = [];
afterEach(() => homes.splice(0).forEach((c) => c()));

function entry(requestId: string, ts: string, over: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      requestId,
      timestamp: ts,
      sessionId: 'sess-1',
      message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, content: [] },
      ...over,
    }) + '\n'
  );
}

function setup() {
  const h = tmpHome();
  homes.push(h.cleanup);
  let t = Date.parse('2026-11-13T10:00:00.000Z');
  const s = makeStores(() => t);
  const file = join(h.dir, 'sess-1.jsonl');
  s.store.touchFromHook('sess-1', { cwd: '/repo', root: '/repo', transcriptPath: file });
  s.store.setStatus('sess-1', 'working');
  const tailer = new TranscriptTailer(s.store, s.outbox, silentLogger, () => t);
  const out = () => s.outbox.nextBatch<UsageRecord>('usage', { maxItems: 200, maxBytes: 1e7 }).map((r) => r.item);
  return { ...s, tailer, file, out, advance: (ms: number) => (t += ms), now: () => t };
}

describe('TranscriptTailer', () => {
  it("mavjud tarix qayta sanalmaydi (EOF'dan boshlanadi), yangi yozuvlar OTel kutish oynasidan keyin chiqadi", async () => {
    const c = setup();
    writeFileSync(c.file, entry('req_old', '2026-11-13T09:00:00.000Z'));
    c.tailer.register('sess-1', c.file);
    appendFileSync(c.file, entry('req_new', '2026-11-13T10:00:00.000Z'));
    await c.tailer.pollOnce();
    expect(c.out()).toHaveLength(0); // hali OTel kutilmoqda

    c.advance(OTEL_GRACE_MS + SETTLE_MS + 1);
    await c.tailer.pollOnce();
    const rows = c.out();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: 'req_new',
      source: 'transcript',
      cwd: '/repo',
      claudeSessionId: 'sess-1',
      ts: Date.parse('2026-11-13T10:00:00.000Z'),
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    });
  });

  it("OTel'dan o'sha requestId kelgan bo'lsa transcript yozuvi chiqmaydi (dedup)", async () => {
    const c = setup();
    c.tailer.register('sess-1', c.file); // fayl hali yo'q: boshidan
    writeFileSync(c.file, entry('req_otel', '2026-11-13T10:00:00.000Z') + entry('req_only_tr', '2026-11-13T10:00:01.000Z'));
    // OTel yetkazdi
    c.outbox.enqueueUsage(usage({ requestId: 'req_otel', ts: Date.parse('2026-11-13T10:00:00.500Z') }));
    c.outbox.ack(c.outbox.nextBatch('usage', { maxItems: 9, maxBytes: 1e7 }).map((r) => r.seq));
    await c.tailer.pollOnce();
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 5000);
    await c.tailer.pollOnce();
    expect(c.out().map((r) => r.requestId)).toEqual(['req_only_tr']);
  });

  it("bitta so'rovning bir nechta yozuvi (thinking/text/tool_use) bitta usage bo'ladi, ts = birinchi yozuv", async () => {
    const c = setup();
    c.tailer.register('sess-1', c.file);
    writeFileSync(
      c.file,
      entry('req_multi', '2026-11-13T10:00:00.000Z') + entry('req_multi', '2026-11-13T10:00:02.000Z') + entry('req_multi', '2026-11-13T10:00:03.000Z'),
    );
    await c.tailer.pollOnce();
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 5000);
    await c.tailer.pollOnce();
    await c.tailer.pollOnce(); // takroriy poll hech narsa qo'shmaydi
    const rows = c.out();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(Date.parse('2026-11-13T10:00:00.000Z'));
  });

  it("to'liq bo'lmagan oxirgi qator keyingi pollda o'qiladi; offset saqlanadi", async () => {
    const c = setup();
    c.tailer.register('sess-1', c.file);
    const full = entry('req_part', '2026-11-13T10:00:00.000Z');
    writeFileSync(c.file, full.slice(0, 40));
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 5000);
    await c.tailer.pollOnce();
    expect(c.out()).toHaveLength(0);
    appendFileSync(c.file, full.slice(40));
    await c.tailer.pollOnce();
    c.advance(SETTLE_MS + 1);
    await c.tailer.pollOnce();
    expect(c.out().map((r) => r.requestId)).toEqual(['req_part']);
    expect(c.store.getOffset(c.file)).toBe(Buffer.byteLength(full));
  });

  it("restartdan keyin (kutayotgan guruh) offset guruh boshiga qaytadi va dublikat bo'lmaydi", async () => {
    const c = setup();
    c.tailer.register('sess-1', c.file);
    const a = entry('req_a', '2026-11-13T10:00:00.000Z');
    writeFileSync(c.file, a);
    await c.tailer.pollOnce();
    expect(c.store.getOffset(c.file)).toBe(0); // kutayotgan guruh: offset oldinga o'tmadi

    const tailer2 = new TranscriptTailer(c.store, c.outbox, silentLogger, c.now);
    tailer2.register('sess-1', c.file);
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 1);
    await tailer2.pollOnce();
    await c.tailer.pollOnce(); // eski nusxa ham chiqarishga urinadi: lokal dedup to'sadi
    expect(c.out()).toHaveLength(1);
  });

  it("fayl qisqarsa boshidan o'qiladi", async () => {
    const c = setup();
    c.tailer.register('sess-1', c.file);
    writeFileSync(c.file, entry('req_1', '2026-11-13T10:00:00.000Z', { pad: 'x'.repeat(500) }));
    await c.tailer.pollOnce();
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 1);
    await c.tailer.pollOnce(); // req_1 chiqdi, kursor fayl oxirida
    writeFileSync(c.file, entry('req_2', '2026-11-13T10:00:10.000Z')); // fayl qisqardi (rotatsiya)
    await c.tailer.pollOnce();
    c.advance(OTEL_GRACE_MS + SETTLE_MS + 1);
    await c.tailer.pollOnce();
    expect(c.out().map((r) => r.requestId).sort()).toEqual(['req_1', 'req_2']);
  });
});
