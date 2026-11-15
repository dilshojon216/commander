import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assistant, line, noise, text, toolResult, toolUse, userPrompt } from '../test/chat-fixtures.js';
import { ChatItemConverter } from './chat-items.js';
import { decodeCursor, readForward, readPage } from './chat-reader.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatrd-'));
  file = join(dir, 's.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const conv = () => new ChatItemConverter({ includeThinking: false });
const texts = (items: Array<{ kind: string }>): string[] => items.filter((i) => i.kind === 'user' || i.kind === 'assistant').map((i) => (i as unknown as { text: string }).text);

/** 1..n: juft = user prompt, toq = assistant javobi; orasida shovqin. */
function writeConversation(n: number): void {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(line(noise[i % noise.length]));
    out.push(line(i % 2 === 0 ? userPrompt(`m${i}`, i) : assistant([text(`m${i}`)], { requestId: `req_${i}`, t: i })));
  }
  writeFileSync(file, out.join('\n') + '\n');
}

describe('readPage (orqaga sahifalash)', () => {
  it('oxirgi N element, kronologik tartibda; kursor eski sahifani beradi', async () => {
    writeConversation(40);
    const p1 = await readPage(file, conv(), 10);
    expect(texts(p1.items)).toEqual(Array.from({ length: 10 }, (_, i) => `m${31 + i}`));
    expect(p1.cursor).not.toBeNull();

    const p2 = await readPage(file, conv(), 10, decodeCursor(p1.cursor!));
    expect(texts(p2.items)).toEqual(Array.from({ length: 10 }, (_, i) => `m${21 + i}`));

    // hammasi bo'lib bitta ham dublikatsiz va bo'shliqsiz
    const all = await readPage(file, conv(), 1000);
    expect(texts(all.items)).toHaveLength(40);
    expect(all.cursor).toBeNull();
  });

  it('usage elementi tanlangan yozuvlarga mos so\'rovlar uchun qo\'shiladi', async () => {
    writeConversation(6);
    const p = await readPage(file, conv(), 2);
    const usage = p.items.filter((i) => i.kind === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.id.startsWith('usage:req_'))).toBe(true);
  });

  it('bo\'sh fayl', async () => {
    writeFileSync(file, '');
    expect(await readPage(file, conv(), 10)).toMatchObject({ items: [], cursor: null, size: 0 });
  });

  it('katta fayl (bir necha chunk) va chunk chegarasidagi qatorlar butun qoladi', async () => {
    const big = 'ъ'.repeat(30_000); // ko'p baytli, har yozuv ~60 KB
    const out: string[] = [];
    for (let i = 1; i <= 60; i++) out.push(line(userPrompt(`${i}:${big}`, i)));
    writeFileSync(file, out.join('\n') + '\n');
    const p = await readPage(file, conv(), 50);
    // matn 16000 belgigacha kesiladi; boshlanishi (raqam) saqlanadi
    const firsts = texts(p.items).map((t) => Number(t.split(':')[0]));
    expect(firsts).toEqual(Array.from({ length: 50 }, (_, i) => 11 + i));
  });

  it('oxirgi yozilayotgan (\\n siz) qator backfill\'ga kirmaydi va jonli kuzatuv uning boshidan davom etadi', async () => {
    writeConversation(4);
    const partial = line(userPrompt('yarim', 9));
    appendFileSync(file, partial.slice(0, 20));
    const c = conv();
    const p = await readPage(file, c, 50);
    expect(texts(p.items)).not.toContain('yarim');
    appendFileSync(file, partial.slice(20) + '\n');
    const f = await readForward(file, c, p.size);
    expect(f.entries.flatMap((e) => e.items).map((i) => (i as { text?: string }).text)).toEqual(['yarim']);
  });
});

describe('readForward (jonli)', () => {
  it('faqat to\'liq qatorlarni oladi, offset oldinga yuradi', async () => {
    writeConversation(2);
    const c = conv();
    const start = (await readPage(file, c, 50)).size;
    appendFileSync(file, line(assistant([toolUse('toolu_1', 'Bash', { command: 'ls' })], { requestId: 'req_x' })) + '\n');
    const half = line(toolResult('toolu_1', 'natija'));
    appendFileSync(file, half.slice(0, 30));
    const r1 = await readForward(file, c, start);
    expect(r1.entries.flatMap((e) => e.items.map((i) => i.kind))).toEqual(['tool_use']);
    appendFileSync(file, half.slice(30) + '\n');
    const r2 = await readForward(file, c, r1.offset);
    const items = r2.entries.flatMap((e) => e.items);
    expect(items[0]).toMatchObject({ kind: 'tool_result', toolName: 'Bash', text: 'natija' });
    expect((await readForward(file, c, r2.offset)).entries).toHaveLength(0);
  });

  it('fayl qisqarsa truncated', async () => {
    writeConversation(4);
    const size = (await readPage(file, conv(), 50)).size;
    writeFileSync(file, line(userPrompt('yangi')) + '\n');
    expect((await readForward(file, conv(), size)).truncated).toBe(true);
  });
});

describe('decodeCursor', () => {
  it('faqat o<raqam>', () => {
    expect(decodeCursor('o123')).toBe(123);
    for (const bad of ['', '123', 'o', 'o-1', 'o1.5', 'ox', 'o' + '9'.repeat(30)]) expect(decodeCursor(bad)).toBeUndefined();
  });
});
