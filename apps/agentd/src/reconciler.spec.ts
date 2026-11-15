import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@commander/contracts';
import { makeStores } from '../test/helpers.js';
import type { LiveSession } from './agents-cli.js';
import { silentLogger } from './logger.js';
import { Reconciler, VANISH_GRACE_MS } from './reconciler.js';

function setup() {
  let t = 10_000_000;
  const s = makeStores(() => t);
  let live: LiveSession[] | Error = [];
  const rec = new Reconciler(s.db, s.store, s.outbox, async () => {
    if (live instanceof Error) throw live;
    return live;
  }, silentLogger, () => t);
  const open = (id: string) => {
    s.store.touchFromHook(id, { cwd: '/p', root: '/p', transcriptPath: null });
    s.store.setStatus(id, 'working');
  };
  return {
    ...s,
    rec,
    open,
    setLive: (l: LiveSession[] | Error) => (live = l),
    advance: (ms: number) => (t += ms),
    events: () => s.outbox.nextBatch<AgentEvent>('events', { maxItems: 100, maxBytes: 1e7 }).map((r) => r.item),
  };
}

describe('Reconciler', () => {
  it("2 ketma-ket yo'qlikdan keyin ended/vanished yuboradi (bittasi yetarli emas)", async () => {
    const c = setup();
    c.open('gone');
    c.open('alive');
    c.advance(VANISH_GRACE_MS + 1);
    c.setLive([{ claudeSessionId: 'alive' }]);
    expect(await c.rec.run()).toEqual([]);
    expect(c.events()).toHaveLength(0);
    expect(await c.rec.run()).toEqual(['gone']);
    const [e] = c.events();
    expect(e).toMatchObject({ claudeSessionId: 'gone', status: 'ended', reason: 'vanished', cwd: '/p' });
    expect(c.store.get('gone')?.status).toBe('ended');
    // qayta yuborilmaydi
    expect(await c.rec.run()).toEqual([]);
    expect(c.events()).toHaveLength(1);
  });

  it("oraliqdagi qaytish hisoblagichni nolga tushiradi", async () => {
    const c = setup();
    c.open('s');
    c.advance(VANISH_GRACE_MS + 1);
    c.setLive([]);
    await c.rec.run();
    c.setLive([{ claudeSessionId: 's' }]);
    await c.rec.run();
    c.setLive([]);
    expect(await c.rec.run()).toEqual([]); // yana 1-miss
    expect(c.events()).toHaveLength(0);
  });

  it("buyruq xatosi miss hisoblanmaydi va lastLive tozalanadi", async () => {
    const c = setup();
    c.open('s');
    c.advance(VANISH_GRACE_MS + 1);
    c.setLive(new Error('claude topilmadi'));
    for (let i = 0; i < 5; i++) expect(await c.rec.run()).toEqual([]);
    expect(c.rec.lastLive).toBeUndefined();
    expect(c.store.get('s')?.misses).toBe(0);
  });

  it("yangi (grace ichidagi) sessiya yo'qolgan hisoblanmaydi", async () => {
    const c = setup();
    c.open('fresh');
    c.setLive([]);
    await c.rec.run();
    await c.rec.run();
    await c.rec.run();
    expect(c.events()).toHaveLength(0);
  });
});
