import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentToCenterMessageSchema, createEnvelope } from '@commander/contracts';
import type { ChatItem } from '@commander/contracts';
import { assistant, line, text, toolUse, userPrompt } from '../test/chat-fixtures.js';
import { chunkItems, ChatStreamManager, dedupeById } from './chat-stream.js';
import { silentLogger } from './logger.js';

const SID = 'sess-live';
let tmp: string;
let root: string;
let file: string;
let sent: Array<{ type: string; payload: Record<string, unknown> }>;
let ready: boolean;
let mgr: ChatStreamManager;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: vaqt tugadi');
    await wait(10);
  }
}
const itemsOf = (payload: Record<string, unknown>): ChatItem[] => payload['items'] as ChatItem[];

function make(maxStreams = 8): ChatStreamManager {
  return new ChatStreamManager(
    { isReady: () => ready, send: (type, payload) => (sent.push({ type, payload: payload as Record<string, unknown> }), true) },
    { log: silentLogger, projectsRoot: () => root, maxStreams, pollMs: 25, flushMs: 10, minSendGapMs: 0 },
  );
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'chatstream-')));
  root = join(tmp, 'projects');
  mkdirSync(join(root, '-p'), { recursive: true });
  file = join(root, '-p', `${SID}.jsonl`);
  writeFileSync(file, [line(userPrompt('birinchi', 1)), line(assistant([text('javob')], { requestId: 'req_1' }))].join('\n') + '\n');
  sent = [];
  ready = true;
  mgr = make();
});
afterEach(() => {
  mgr.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

describe('ChatStreamManager', () => {
  it('start: backfill (replace + done), keyin jonli qo\'shimcha element; stop jonli oqimni to\'xtatadi', async () => {
    const streamId = randomUUID();
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 200 });
    const first = sent[0]!;
    expect(first.type).toBe('chat.items');
    expect(first.payload).toMatchObject({ streamId, replace: true, done: true, cursor: null });
    expect(itemsOf(first.payload).map((i) => i.kind)).toEqual(['user', 'assistant', 'usage']);
    expect(mgr.count()).toBe(1);

    appendFileSync(file, line(assistant([toolUse('toolu_1', 'Bash', { command: 'echo salom' })], { requestId: 'req_2' })) + '\n');
    await until(() => sent.some((m) => itemsOf(m.payload).some((i) => i.kind === 'tool_use')));
    const live = sent.find((m) => itemsOf(m.payload).some((i) => i.kind === 'tool_use'))!;
    expect(live.payload['replace']).toBeUndefined();
    expect(itemsOf(live.payload).find((i) => i.kind === 'tool_use')).toMatchObject({ summary: 'Bash: echo salom' });

    mgr.onStop(streamId);
    expect(mgr.count()).toBe(0);
    const n = sent.length;
    appendFileSync(file, line(userPrompt('stopdan keyin', 9)) + '\n');
    await wait(150);
    expect(sent.length).toBe(n);
  });

  it('agent -> center xabarlari kontraktga mos', async () => {
    const streamId = randomUUID();
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 200 });
    for (const m of sent) expect(AgentToCenterMessageSchema.safeParse(createEnvelope(m.type, m.payload)).success).toBe(true);
  });

  it('bir xil streamId bilan qayta start = resync (replace bilan qayta backfill), yangi oqim yaratilmaydi', async () => {
    const streamId = randomUUID();
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 200 });
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 200 });
    expect(mgr.count()).toBe(1);
    expect(sent.filter((m) => m.payload['replace'] === true)).toHaveLength(2);
  });

  it('bir vaqtdagi oqimlar chegarasi: ortig\'iga busy', async () => {
    mgr = make(2);
    await mgr.onStart({ streamId: randomUUID(), claudeSessionId: SID, tail: 10 });
    await mgr.onStart({ streamId: randomUUID(), claudeSessionId: SID, tail: 10 });
    const third = randomUUID();
    await mgr.onStart({ streamId: third, claudeSessionId: SID, tail: 10 });
    expect(mgr.count()).toBe(2);
    expect(sent.at(-1)).toMatchObject({ type: 'chat.error', payload: { streamId: third, code: 'busy' } });
  });

  it('transcript topilmasa not_found; tashqi yo\'l forbidden_path (oqim yaratilmaydi)', async () => {
    const a = randomUUID();
    await mgr.onStart({ streamId: a, claudeSessionId: 'yoq-sessiya', tail: 10 });
    expect(sent.at(-1)).toMatchObject({ type: 'chat.error', payload: { streamId: a, code: 'not_found' } });
    const b = randomUUID();
    writeFileSync(join(tmp, 'secret.jsonl'), line(userPrompt('sir')) + '\n');
    await mgr.onStart({ streamId: b, claudeSessionId: 'secret', transcriptPath: join(tmp, 'secret.jsonl'), tail: 10 });
    expect(sent.at(-1)).toMatchObject({ type: 'chat.error', payload: { streamId: b, code: 'forbidden_path' } });
    expect(mgr.count()).toBe(0);
    expect(JSON.stringify(sent)).not.toContain('sir');
  });

  it('page: eski sahifa faqat pageId bilan, older:true', async () => {
    const out: string[] = [];
    for (let i = 1; i <= 30; i++) out.push(line(userPrompt(`m${i}`, i)));
    writeFileSync(file, out.join('\n') + '\n');
    const streamId = randomUUID();
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 10 });
    const cursor = sent[0]!.payload['cursor'] as string;
    expect(cursor).toMatch(/^o\d+$/);
    const pageId = randomUUID();
    await mgr.onPage({ streamId, pageId, before: cursor, limit: 10 });
    const page = sent.find((m) => m.payload['pageId'] === pageId)!;
    expect(page.payload).toMatchObject({ older: true, done: true });
    expect(itemsOf(page.payload).map((i) => (i as { text: string }).text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${11 + i}`));
  });

  it('stopAll (WS uzildi): hamma oqim yopiladi, keyingi fayl o\'zgarishi yuborilmaydi', async () => {
    await mgr.onStart({ streamId: randomUUID(), claudeSessionId: SID, tail: 10 });
    await mgr.onStart({ streamId: randomUUID(), claudeSessionId: SID, tail: 10 });
    mgr.stopAll();
    expect(mgr.count()).toBe(0);
    const n = sent.length;
    appendFileSync(file, line(userPrompt('keyin', 9)) + '\n');
    await wait(120);
    expect(sent.length).toBe(n);
  });

  it('sirlar oqim orqali ham chiqmaydi', async () => {
    const LEAK = 'S3cr3tV4lue99';
    const streamId = randomUUID();
    await mgr.onStart({ streamId, claudeSessionId: SID, tail: 10 });
    appendFileSync(file, line(userPrompt(`API_KEY=${LEAK} Bearer abcdefghijklmnop1234`, 5)) + '\n');
    await until(() => sent.some((m) => itemsOf(m.payload).some((i) => i.kind === 'user' && i.text.includes('REDACTED'))));
    expect(JSON.stringify(sent)).not.toContain(LEAK);
    expect(JSON.stringify(sent)).not.toContain('abcdefghijklmnop1234');
  });
});

describe('yordamchilar', () => {
  it('chunkItems: element va bayt chegaralari', () => {
    const mk = (i: number, size = 10): ChatItem => ({ kind: 'user', id: `u${i}`, ts: 0, text: 'x'.repeat(size) });
    expect(chunkItems(Array.from({ length: 250 }, (_, i) => mk(i))).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunkItems([mk(1, 600), mk(2, 600), mk(3, 600)], 100, 1000).map((c) => c.length)).toEqual([1, 1, 1]);
    expect(chunkItems([])).toEqual([]);
  });

  it('dedupeById: oxirgi qoladi, tartib saqlanadi', () => {
    const u = (n: number): ChatItem => ({ kind: 'usage', id: 'usage:r', ts: n, requestId: 'r', inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const a: ChatItem = { kind: 'user', id: 'a', ts: 0, text: 'a' };
    const out = dedupeById([u(1), a, u(2)]);
    expect(out.map((i) => i.id)).toEqual(['a', 'usage:r']);
    expect(out[1]).toMatchObject({ inputTokens: 2 });
  });
});
