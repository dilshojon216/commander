import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { CHAT_LIMITS } from '@commander/contracts';
import type { ChatItem } from '@commander/contracts';
import { AgentDispatchService } from '../realtime/agent-dispatch.service.js';
import type { AuditService } from '../identity/audit/audit.service.js';
import { ChatRelayService, sanitizeItem } from './chat-relay.service.js';
import type { ChatClientPort } from './chat-relay.service.js';

const MACHINE = randomUUID();
const OTHER_MACHINE = randomUUID();
const SESSION = randomUUID();

class FakePort implements ChatClientPort {
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  constructor(
    readonly deviceId: string | null = randomUUID(),
    readonly actorKind: string | null = 'web',
  ) {}
  pushChat(type: 'chat.items' | 'chat.state', payload: unknown): void {
    this.sent.push({ type, payload: payload as Record<string, unknown> });
  }
  states(): string[] {
    return this.sent.filter((m) => m.type === 'chat.state').map((m) => m.payload['state'] as string);
  }
  items(): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === 'chat.items').map((m) => m.payload);
  }
}

interface AgentMsg { type: string; payload: Record<string, unknown> }

function setup(opts: { online?: boolean; rows?: Array<Record<string, unknown>> } = {}) {
  const dispatch = new AgentDispatchService();
  const toAgent: AgentMsg[] = [];
  let online = opts.online ?? true;
  const sender = { deviceId: 'dev', send: (type: string, payload: unknown) => (online ? (toAgent.push({ type, payload: payload as Record<string, unknown> }), true) : false) };
  if (online) dispatch.register(MACHINE, sender);
  const query = vi.fn().mockResolvedValue(opts.rows ?? [{ machine_id: MACHINE, claude_session_id: 'claude-s1', transcript_path: '/h/.claude/projects/p/claude-s1.jsonl' }]);
  const record = vi.fn().mockResolvedValue(undefined);
  const relay = new ChatRelayService({ query } as unknown as DataSource, dispatch, { record } as unknown as AuditService);
  relay.onModuleInit();
  return {
    relay,
    dispatch,
    toAgent,
    query,
    record,
    sender,
    goOffline: () => {
      online = false;
      dispatch.unregister(MACHINE, sender);
    },
    goOnline: () => {
      online = true;
      dispatch.register(MACHINE, sender);
    },
    starts: () => toAgent.filter((m) => m.type === 'chat.stream.start'),
    stops: () => toAgent.filter((m) => m.type === 'chat.stream.stop'),
  };
}

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, ts: 1, text });
const itemsMsg = (streamId: string, over: Record<string, unknown> = {}) => ({ streamId, items: [user('u1', 'salom')], replace: true, done: true, cursor: null, ...over }) as never;

beforeEach(() => vi.useRealTimers());

describe('ChatRelayService: ochish va backfill', () => {
  it('chat.open -> connecting + agentga start (tail, transcriptPath); backfill -> klientga items + live', async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION, limit: 50 });
    expect(port.states()).toEqual(['connecting']);
    const start = f.starts()[0]!;
    expect(start.payload).toMatchObject({ claudeSessionId: 'claude-s1', tail: 50, transcriptPath: '/h/.claude/projects/p/claude-s1.jsonl' });
    expect(start.payload['includeThinking']).toBeUndefined();

    f.relay.onAgentItems(MACHINE, itemsMsg(start.payload['streamId'] as string));
    expect(port.items()[0]).toMatchObject({ sessionId: SESSION, replace: true, cursor: null });
    expect(port.states()).toEqual(['connecting', 'live']);

    // jonli qo'shimcha
    f.relay.onAgentItems(MACHINE, { streamId: start.payload['streamId'], items: [user('u2', 'yangi')] } as never);
    expect(port.items()[1]).toMatchObject({ items: [{ id: 'u2' }] });
    expect(port.items()[1]!['replace']).toBeUndefined();
  });

  it("noma'lum sessiya: unavailable", async () => {
    const f = setup({ rows: [] });
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    expect(port.sent[0]).toMatchObject({ type: 'chat.state', payload: { state: 'unavailable', code: 'not_found' } });
    expect(f.toAgent).toHaveLength(0);
  });

  it('agent chat.error: not_found -> unavailable, boshqalari -> error; qayta open qayta urinadi', async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    const id1 = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentError(MACHINE, { streamId: id1, code: 'not_found' });
    expect(port.states().at(-1)).toBe('unavailable');
    await f.relay.open(port, { sessionId: SESSION });
    expect(f.starts()).toHaveLength(2);
    const id2 = f.starts()[1]!.payload['streamId'] as string;
    expect(id2).not.toBe(id1);
    f.relay.onAgentError(MACHINE, { streamId: id2, code: 'busy' });
    expect(port.sent.at(-1)).toMatchObject({ payload: { state: 'error', code: 'busy' } });
  });

  it("start javobi kelmasa (timeout) 'error' holati", async () => {
    vi.useFakeTimers();
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    vi.advanceTimersByTime(CHAT_LIMITS.startTimeoutMs + 10);
    expect(port.states().at(-1)).toBe('error');
    expect(f.stops()).toHaveLength(1);
  });
});

describe('ChatRelayService: ref-count (bitta agent oqimi, ko\'p klient)', () => {
  it('ikkinchi klient resync oladi, birinchisi qayta backfill olmaydi; oxirgi klient ketgach stop', async () => {
    const f = setup();
    const a = new FakePort();
    const b = new FakePort();
    await f.relay.open(a, { sessionId: SESSION });
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId));
    expect(a.states().at(-1)).toBe('live');

    await f.relay.open(b, { sessionId: SESSION });
    // bitta oqim: yangi stream emas, o'sha streamId bilan resync
    expect(f.starts()).toHaveLength(2);
    expect(f.starts()[1]!.payload['streamId']).toBe(streamId);
    expect(f.relay.streamCount).toBe(1);
    expect(f.relay.clientCount(SESSION)).toBe(2);

    const aBefore = a.items().length;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId, { items: [user('u1', 'salom')] }));
    expect(a.items().length).toBe(aBefore); // A resync backfill'ini olmaydi
    expect(b.items()).toHaveLength(1);
    expect(b.states().at(-1)).toBe('live');

    // jonli element ikkalasiga
    f.relay.onAgentItems(MACHINE, { streamId, items: [user('u9', 'jonli')] } as never);
    expect(a.items().at(-1)).toMatchObject({ items: [{ id: 'u9' }] });
    expect(b.items().at(-1)).toMatchObject({ items: [{ id: 'u9' }] });

    f.relay.close(a, SESSION);
    expect(f.stops()).toHaveLength(0);
    expect(f.relay.streamCount).toBe(1);
    f.relay.close(b, SESSION);
    expect(f.stops()).toHaveLength(1);
    expect(f.stops()[0]!.payload).toEqual({ streamId });
    expect(f.relay.streamCount).toBe(0);
  });

  it('releaseAll (ulanish uzildi) hamma obunani tozalaydi va oxirgi klient ketsa to\'xtatadi', async () => {
    const f = setup();
    const a = new FakePort();
    await f.relay.open(a, { sessionId: SESSION });
    f.relay.releaseAll(a);
    expect(f.stops()).toHaveLength(1);
    expect(f.relay.streamCount).toBe(0);
  });

  it('ko\'p chunkli backfill o\'rtasida qo\'shilgan klient to\'liq bo\'lmagan backfill olmaydi: done\'da resync', async () => {
    const f = setup();
    const a = new FakePort();
    const b = new FakePort();
    await f.relay.open(a, { sessionId: SESSION });
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId, { done: false })); // 1-chunk
    await f.relay.open(b, { sessionId: SESSION }); // o'rtada
    f.relay.onAgentItems(MACHINE, { streamId, items: [user('u2', 'ikkinchi')], done: true } as never); // oxirgi chunk
    expect(a.states().at(-1)).toBe('live');
    expect(b.items()).toHaveLength(0);
    expect(b.states().at(-1)).toBe('connecting');
    expect(f.starts()).toHaveLength(2); // resync so'raldi
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId));
    expect(b.items()).toHaveLength(1);
    expect(b.states().at(-1)).toBe('live');
  });

  it('begona mashina yoki noma\'lum oqim xabarlari jim tashlanadi', async () => {
    const f = setup();
    const a = new FakePort();
    await f.relay.open(a, { sessionId: SESSION });
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(OTHER_MACHINE, itemsMsg(streamId));
    f.relay.onAgentItems(MACHINE, itemsMsg(randomUUID()));
    f.relay.onAgentError(OTHER_MACHINE, { streamId, code: 'internal' });
    expect(a.items()).toHaveLength(0);
    expect(a.states()).toEqual(['connecting']);
  });
});

describe('ChatRelayService: offline', () => {
  it('mashina offline: open -> offline (start yo\'q); mashina qaytsa avtomatik start, backfill -> live', async () => {
    const f = setup({ online: false });
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    expect(port.states()).toEqual(['offline']);
    expect(f.toAgent).toHaveLength(0);

    f.goOnline();
    expect(port.states().at(-1)).toBe('connecting');
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId));
    expect(port.states().at(-1)).toBe('live');
  });

  it("jonli oqim paytida mashina uzilsa: offline; qaytsa yangi streamId bilan qayta boshlanadi", async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    const id1 = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(id1));
    f.goOffline();
    expect(port.states().at(-1)).toBe('offline');
    // eskirgan oqim xabarlari endi qabul qilinmaydi
    const n = port.items().length;
    f.relay.onAgentItems(MACHINE, { streamId: id1, items: [user('x', 'eski')] } as never);
    expect(port.items().length).toBe(n);
    f.goOnline();
    expect(port.states().at(-1)).toBe('connecting');
    const id2 = f.starts().at(-1)!.payload['streamId'] as string;
    expect(id2).not.toBe(id1);
    f.relay.onAgentItems(MACHINE, itemsMsg(id2));
    expect(port.states().at(-1)).toBe('live');
  });

  it('offline paytida oxirgi klient ketsa: stop yuborilmaydi (oqim yo\'q), oqim o\'chadi', async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    f.goOffline();
    f.relay.close(port, SESSION);
    expect(f.stops()).toHaveLength(0);
    expect(f.relay.streamCount).toBe(0);
    f.goOnline();
    expect(f.starts()).toHaveLength(1); // qayta boshlanmaydi
  });
});

describe('ChatRelayService: sahifalash, chegaralar, audit, redakt', () => {
  it('before: faqat so\'ragan klientga older:true sahifa', async () => {
    const f = setup();
    const a = new FakePort();
    const b = new FakePort();
    await f.relay.open(a, { sessionId: SESSION });
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId, { cursor: 'o500' }));
    await f.relay.open(b, { sessionId: SESSION });
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId, { cursor: 'o500' }));

    await f.relay.open(a, { sessionId: SESSION, before: 'o500', limit: 30 });
    const page = f.toAgent.find((m) => m.type === 'chat.stream.page')!;
    expect(page.payload).toMatchObject({ streamId, before: 'o500', limit: 30 });
    const aN = a.items().length;
    const bN = b.items().length;
    f.relay.onAgentItems(MACHINE, { streamId, pageId: page.payload['pageId'], items: [user('old', 'eski')], older: true, cursor: 'o100', done: true } as never);
    expect(a.items().length).toBe(aN + 1);
    expect(a.items().at(-1)).toMatchObject({ older: true, cursor: 'o100', items: [{ id: 'old' }] });
    expect(b.items().length).toBe(bN);
  });

  it('bir klient ko\'pi bilan maxOpenPerClient ta sessiya', async () => {
    const f = setup();
    const port = new FakePort();
    for (let i = 0; i < CHAT_LIMITS.maxOpenPerClient; i++) {
      f.query.mockResolvedValueOnce([{ machine_id: MACHINE, claude_session_id: `c${i}`, transcript_path: null }]);
      await f.relay.open(port, { sessionId: randomUUID() });
    }
    await f.relay.open(port, { sessionId: randomUUID() });
    expect(port.sent.at(-1)).toMatchObject({ payload: { state: 'error', code: 'busy' } });
  });

  it('chat.open tezligi cheklanadi', async () => {
    const f = setup();
    const port = new FakePort('11111111-1111-4111-8111-111111111111');
    let last: string = 'ok';
    for (let i = 0; i < 40; i++) last = await f.relay.open(port, { sessionId: SESSION });
    expect(last).toBe('rate_limited');
  });

  it('audit: chat.opened (kim/qaysi sessiya, mazmunsiz), dublikat 60 s ichida yozilmaydi', async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    await f.relay.open(port, { sessionId: SESSION });
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.record.mock.calls[0]![0]).toMatchObject({ action: 'chat.opened', actorDeviceId: port.deviceId, actorKind: 'web', target: SESSION, details: { machine_id: MACHINE } });
    f.relay.onAgentItems(MACHINE, itemsMsg(f.starts()[0]!.payload['streamId'] as string, { items: [user('u', 'MAXFIY MATN')] }));
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('MAXFIY');
  });

  it('markaz ham redakt qiladi (agentd xato qilsa ham)', async () => {
    const f = setup();
    const port = new FakePort();
    await f.relay.open(port, { sessionId: SESSION });
    const streamId = f.starts()[0]!.payload['streamId'] as string;
    f.relay.onAgentItems(MACHINE, itemsMsg(streamId, { items: [user('u', 'token ghp_abcdefghijklmnopqrstuvwx1234 va API_KEY=S3cr3tV4lue99')] }));
    const json = JSON.stringify(port.items());
    expect(json).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    expect(json).not.toContain('S3cr3tV4lue99');
  });

  it('sanitizeItem: tool_use summary va tool_result matni', () => {
    const tu = sanitizeItem({ kind: 'tool_use', id: 'a', ts: 0, toolUseId: 't', toolName: 'Bash', summary: 'Bash: curl -H "Authorization: Bearer abcdefghijklmnop1234"' });
    expect(JSON.stringify(tu)).not.toContain('abcdefghijklmnop1234');
    const tr = sanitizeItem({ kind: 'tool_result', id: 'b', ts: 0, toolUseId: 't', ok: true, text: 'password=hunter2hunter2', truncated: false });
    expect(JSON.stringify(tr)).not.toContain('hunter2hunter2');
  });
});
