import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ChatItem } from '@commander/contracts';
import type { ChatItemConverter, ConvertedEntry } from './chat-items.js';

/**
 * Transcript JSONL'ni o'qish: (a) oxiridan ORQAGA sahifalab (backfill / eski sahifa), (b) offsetdan OLDINGA (jonli kuzatuv).
 * Faqat bayt darajasidagi ish; matn `ChatItemConverter` ga beriladi. Hech narsa logga yozilmaydi.
 */

const CHUNK_BYTES = 1024 * 1024;
/** Bitta so'rovda orqaga qarab ko'pi bilan shuncha bayt skanerlanadi. */
export const MAX_BACKWARD_SCAN_BYTES = 64 * 1024 * 1024;
/** Bitta qator (tool natijalari/blob'lar) shundan katta bo'lsa tashlanadi. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Jonli kuzatuvda bitta o'qishda ko'pi bilan. */
export const MAX_FORWARD_READ_BYTES = 8 * 1024 * 1024;

/** `{"type":"api-request...` kabi chat bo'lmagan yozuvlar tez filtrlanadi (type birinchi kalit bo'lganda). */
const NON_CHAT_PREFIX = /^\{"type":"(?!user"|assistant"|system")/;
const SKIP_TYPE_FAST = (line: string): boolean => NON_CHAT_PREFIX.test(line.slice(0, 40));

interface RawLine {
  offset: number;
  text: string;
}

export interface PageResult {
  items: ChatItem[];
  /** Keyingi eski sahifa uchun `before` (`o<offset>`) yoki `null` (fayl boshiga yetildi). */
  cursor: string | null;
  /** Skanerlash tugagan paytdagi fayl hajmi (`before` yo'q so'rovda: jonli kuzatuv boshlanadigan offset). */
  size: number;
}

export const encodeCursor = (offset: number): string => `o${offset}`;
export function decodeCursor(c: string): number | undefined {
  const m = /^o(\d{1,15})$/.exec(c);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

/**
 * `endOffset` dan oldingi (`[0, endOffset)`) `limit` ta elementni topadi: yozuvlar oxiridan boshiga qarab yig'iladi,
 * keyin KRONOLOGIK tartibda aylantiriladi (tool_use -> tool_result juftlash shu tartibni talab qiladi). Yozuv
 * bo'linmaydi: bitta yozuvning hamma elementlari birga. `before` berilmasa `endOffset` = joriy fayl hajmi.
 */
export async function readPage(path: string, conv: ChatItemConverter, limit: number, before?: number): Promise<PageResult> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    // Oxirgi qator yozilayotgan bo'lishi mumkin (\n siz): jonli kuzatuv shu qatorning BOSHIDAN davom etishi kerak
    const end = before !== undefined ? Math.min(before, size) : await lastCompleteLineEnd(fh, size);

    const lines: RawLine[] = []; // yangidan eskiga
    let pos = end;
    let leftover: Buffer = Buffer.alloc(0);
    let scanned = 0;
    let interesting = 0;
    let want = limit; // "qiziqarli" yozuvlar soni maqsadi; yetmasa oshiriladi
    let entries: Array<{ offset: number; conv: ConvertedEntry }> = [];

    const collectMore = async (): Promise<void> => {
      while (pos > 0 && scanned < MAX_BACKWARD_SCAN_BYTES && interesting < want) {
        const start = Math.max(0, pos - CHUNK_BYTES);
        const chunk = await readAt(fh, start, pos - start);
        scanned += chunk.length;
        const buf = leftover.length > 0 ? Buffer.concat([chunk, leftover]) : chunk;
        let from = 0;
        if (start > 0) {
          // birinchi (to'liq bo'lmasligi mumkin) bo'lak keyingi chunk bilan birlashadi
          const nl = buf.indexOf(0x0a);
          if (nl === -1) {
            leftover = buf.length > MAX_LINE_BYTES ? Buffer.alloc(0) : buf;
            pos = start;
            continue;
          }
          leftover = buf.subarray(0, nl);
          from = nl + 1;
        } else {
          leftover = Buffer.alloc(0);
        }
        const baseOffset = start; // buf = [chunk, leftover]: boshi chunk boshi
        // [from, buf.length) ichidagi to'liq qatorlar (har biri \n bilan tugagan; oxirgisi ham)
        const found: RawLine[] = [];
        let ls = from;
        for (;;) {
          const nl = buf.indexOf(0x0a, ls);
          const le = nl === -1 ? buf.length : nl;
          if (le > ls && le - ls <= MAX_LINE_BYTES) {
            const text = buf.toString('utf8', ls, le);
            if (!SKIP_TYPE_FAST(text)) found.push({ offset: baseOffset + ls, text });
          }
          if (nl === -1) break;
          ls = nl + 1;
        }
        for (let i = found.length - 1; i >= 0; i--) {
          lines.push(found[i]!);
          interesting++;
        }
        pos = start;
      }
    };

    for (let round = 0; round < 8; round++) {
      await collectMore();
      // Kronologik aylantirish (eskidan yangiga)
      const conv2 = conv; // bitta konverter: tool xotirasi va usage yig'indisi shu o'qish uchun
      entries = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        entries.push({ offset: l.offset, conv: conv2.convertLine(l.text) });
      }
      const total = entries.reduce((n, e) => n + e.conv.items.length, 0);
      const exhausted = pos === 0 || scanned >= MAX_BACKWARD_SCAN_BYTES;
      if (total >= limit || exhausted) break;
      want = interesting + (limit - total) + 10;
    }

    // Eng oxirgi yozuvlardan boshlab limitgacha (yozuvni bo'lmasdan)
    let acc = 0;
    let startIdx = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      const n = entries[i]!.conv.items.length;
      if (n === 0) {
        startIdx = i;
        continue;
      }
      if (acc + n > limit && acc > 0) break;
      acc += n;
      startIdx = i;
    }
    const chosen = entries.slice(startIdx);
    const items: ChatItem[] = [];
    const requestIds = new Set<string>();
    for (const e of chosen) {
      items.push(...e.conv.items);
      for (const r of e.conv.requestIds) requestIds.add(r);
    }
    items.push(...conv.usageItems(requestIds));

    // Kursor: tanlangan birinchi yozuvning offseti (undan oldingi qism keyingi sahifada); fayl boshiga yetgan bo'lsa null
    const first = chosen[0];
    const cursorOffset = first ? first.offset : pos;
    const reachedStart = startIdx === 0 && pos === 0; // skanerlangan hamma yozuv tanlandi va fayl boshiga yetildi
    return { items, cursor: reachedStart || cursorOffset <= 0 ? null : encodeCursor(cursorOffset), size: end };
  } finally {
    await fh.close();
  }
}

/** Faylning oxirgi TO'LIQ qatori tugaydigan offset (`\n` dan keyin). `\n` yo'q bo'lsa 0. */
async function lastCompleteLineEnd(fh: FileHandle, size: number): Promise<number> {
  if (size === 0) return 0;
  const last = await readAt(fh, size - 1, 1);
  if (last[0] === 0x0a) return size;
  let pos = size;
  while (pos > 0 && size - pos < MAX_LINE_BYTES) {
    const start = Math.max(0, pos - 64 * 1024);
    const buf = await readAt(fh, start, pos - start);
    const nl = buf.lastIndexOf(0x0a);
    if (nl !== -1) return start + nl + 1;
    pos = start;
  }
  return 0;
}

export interface ForwardResult {
  entries: ConvertedEntry[];
  /** Yangi o'qish kursori (oxirgi TO'LIQ qatordan keyin). */
  offset: number;
  /** Fayl `offset` dan kichik bo'lib qoldi (kesildi): chaqiruvchi resync qiladi. */
  truncated: boolean;
}

/** `offset` dan faylning hozirgi oxirigacha (yoki `MAX_FORWARD_READ_BYTES`) to'liq qatorlarni konvertatsiya qiladi. */
export async function readForward(path: string, conv: ChatItemConverter, offset: number): Promise<ForwardResult> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < offset) return { entries: [], offset, truncated: true };
    if (size === offset) return { entries: [], offset, truncated: false };
    const buf = await readAt(fh, offset, Math.min(size - offset, MAX_FORWARD_READ_BYTES));
    const entries: ConvertedEntry[] = [];
    let ls = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, ls);
      if (nl === -1) break; // to'liq bo'lmagan oxirgi qator: keyingi aylanish
      if (nl > ls && nl - ls <= MAX_LINE_BYTES) {
        const text = buf.toString('utf8', ls, nl);
        if (!SKIP_TYPE_FAST(text)) entries.push(conv.convertLine(text));
      }
      ls = nl + 1;
    }
    // Juda uzun to'liq bo'lmagan qator (MAX_LINE_BYTES dan katta) cheksiz kutmasin: o'tkazib yuboramiz
    let consumed = ls;
    if (ls === 0 && buf.length > MAX_LINE_BYTES) consumed = buf.length;
    return { entries, offset: offset + consumed, truncated: false };
  } finally {
    await fh.close();
  }
}
