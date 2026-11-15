import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEventSchema, parseErrorLoopMessage } from '@commander/contracts';
import type { AgentEvent } from '@commander/contracts';
import { makeStores, tmpHome } from '../test/helpers.js';
import { ErrorLoopEmitter, ErrorLoopTracker, ERROR_LOOP_WINDOW_MS, hashErrorText, toolErrorHashFromLine } from './error-loop.js';
import { silentLogger } from './logger.js';
import { TranscriptTailer } from './transcript-tailer.js';

const errLine = (text: unknown, isError = true): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: isError, content: text }] } });

describe('toolErrorHashFromLine', () => {
  it('xato tool_result: 12 belgili xesh; matn qaytmaydi', () => {
    const h = toolErrorHashFromLine(errLine('Error: ENOENT /Users/alex/secret-project/.env not found'));
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).not.toContain('ENOENT');
  });

  it('bir xil xato turli yo\'l/raqam/hex bilan bir xil xesh; boshqa xato boshqa xesh', () => {
    const a = toolErrorHashFromLine(errLine('Command failed with exit code 1: pid 4411 at /tmp/a/b.js:12'));
    const b = toolErrorHashFromLine(errLine('Command failed with exit code 1: pid 9 at /var/x/y.js:99'));
    const c = toolErrorHashFromLine(errLine('Permission denied'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(hashErrorText('abc 0123456789abcdef')).toBe(hashErrorText('abc fedcba9876543210'));
  });

  it('matn massivi (content bo\'laklari) ham qo\'llab-quvvatlanadi', () => {
    const a = toolErrorHashFromLine(errLine([{ type: 'text', text: 'boom 1' }]));
    expect(a).toBe(toolErrorHashFromLine(errLine('boom 2')));
  });

  it('xato bo\'lmagan natija, yaroqsiz JSON, boshqa qatorlar: null', () => {
    expect(toolErrorHashFromLine(errLine('ok', false))).toBeNull();
    expect(toolErrorHashFromLine('{not json "tool_result" "is_error"')).toBeNull();
    expect(toolErrorHashFromLine('')).toBeNull();
    expect(toolErrorHashFromLine(JSON.stringify({ type: 'assistant', message: { content: [] } }))).toBeNull();
  });
});

describe('ErrorLoopTracker', () => {
  it('5-chi takrorda signal, 10-chida yana; oynadan tashqari eskilar hisoblanmaydi', () => {
    const t = new ErrorLoopTracker(5, ERROR_LOOP_WINDOW_MS);
    const hits: Array<number | null> = [];
    for (let i = 0; i < 10; i++) hits.push(t.record('s', 'h1', i * 1000)?.count ?? null);
    expect(hits).toEqual([null, null, null, null, 5, null, null, null, null, 10]);

    const slow = new ErrorLoopTracker(5, ERROR_LOOP_WINDOW_MS);
    // har 3 daqiqada bitta: oynada (10 daq) eng ko'pi 4 ta
    for (let i = 0; i < 12; i++) expect(slow.record('s', 'h', i * 3 * 60_000)).toBeNull();
  });

  it('xeshlar va sessiyalar mustaqil; forget tozalaydi', () => {
    const t = new ErrorLoopTracker(3, 1000);
    for (let i = 0; i < 2; i++) {
      expect(t.record('a', 'x', i)).toBeNull();
      expect(t.record('a', 'y', i)).toBeNull();
      expect(t.record('b', 'x', i)).toBeNull();
    }
    expect(t.record('a', 'x', 2)).toEqual({ hash: 'x', count: 3 });
    t.forget('a');
    expect(t.record('a', 'x', 3)).toBeNull();
  });
});

describe('ErrorLoopEmitter + TranscriptTailer', () => {
  const homes: Array<() => void> = [];
  afterEach(() => homes.splice(0).forEach((c) => c()));

  function setup() {
    const h = tmpHome();
    homes.push(h.cleanup);
    let t = Date.parse('2026-11-13T10:00:00.000Z');
    const s = makeStores(() => t);
    const file = join(h.dir, 'sess-1.jsonl');
    s.store.touchFromHook('sess-1', { cwd: '/repo', root: '/repo', transcriptPath: file });
    s.store.setStatus('sess-1', 'working');
    let woke = 0;
    const emitter = new ErrorLoopEmitter(s.store, s.outbox, () => woke++);
    const tailer = new TranscriptTailer(s.store, s.outbox, silentLogger, () => t, () => undefined, emitter);
    const events = (): AgentEvent[] => s.outbox.nextBatch<AgentEvent>('events', { maxItems: 200, maxBytes: 1e7 }).map((r) => r.item);
    return { ...s, emitter, tailer, file, events, advance: (ms: number) => (t += ms), woke: () => woke };
  }

  it('transcript\'dagi 5 ta bir xil xato: bitta ErrorLoop hodisasi (kontraktga mos, matnsiz, joriy holat)', async () => {
    const c = setup();
    writeFileSync(c.file, '');
    c.tailer.register('sess-1', c.file);
    for (let i = 0; i < 4; i++) appendFileSync(c.file, errLine(`boom ${i}`) + '\n');
    await c.tailer.pollOnce();
    expect(c.events()).toHaveLength(0);
    appendFileSync(c.file, errLine('boom 99') + '\n');
    await c.tailer.pollOnce();
    const [e] = c.events();
    expect(c.events()).toHaveLength(1);
    expect(AgentEventSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({ claudeSessionId: 'sess-1', event: 'ErrorLoop', status: 'working', cwd: '/repo', notificationType: 'error_loop' });
    expect(parseErrorLoopMessage(e!.message)).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{12}$/), count: 5 });
    expect(JSON.stringify(e)).not.toContain('boom');
    expect(c.woke()).toBe(1);
  });

  it('tugagan sessiya uchun hodisa chiqmaydi', () => {
    const c = setup();
    c.store.setStatus('sess-1', 'ended');
    for (let i = 0; i < 6; i++) c.emitter.feed('sess-1', errLine('boom'), 1000 + i);
    expect(c.events()).toHaveLength(0);
  });
});
