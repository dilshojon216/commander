import { LOG_LIMITS } from '@commander/contracts';

/**
 * Log oqimining xotiradagi chegaralangan buferi (6.6). Hech narsa diskka/DB'ga yozilmaydi. Har qator o'suvchi `seq` oladi;
 * bufer to'lganda (qator yoki bayt) eng eskilari tashlanadi; klient `after` bilan o'qiydi va tashlangan qatorlar soni
 * (`dropped`) bildiriladi. Agent orqa bosim tufayli qator tashlagan bo'lsa (`noteAgentDrop`) ular ham hisobga olinadi.
 */
export interface LogBufferOptions {
  maxBytes?: number;
  maxLines?: number;
}

interface Entry {
  seq: number;
  line: string;
  bytes: number;
}

const MAX_GAPS = 200;

export class LogBuffer {
  private entries: Entry[] = [];
  private bytes = 0;
  private nextSeq = 0;
  /** Bufer to'lib tashlangan qatorlar uchun birinchi saqlanayotgan seq. */
  private firstSeq = 0;
  private readonly gaps: Array<{ atSeq: number; n: number }> = [];
  private readonly maxBytes: number;
  private readonly maxLines: number;

  constructor(o: LogBufferOptions = {}) {
    this.maxBytes = o.maxBytes ?? LOG_LIMITS.centerBufferBytes;
    this.maxLines = o.maxLines ?? LOG_LIMITS.centerBufferLines;
  }

  get size(): number {
    return this.entries.length;
  }

  get next(): number {
    return this.nextSeq;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** Agent `n` qator tashladi (shu nuqtadan OLDIN): `read` ularni `dropped` ga qo'shadi. */
  noteAgentDrop(n: number): void {
    if (n <= 0) return;
    this.gaps.push({ atSeq: this.nextSeq, n });
    if (this.gaps.length > MAX_GAPS) this.gaps.shift();
  }

  append(lines: readonly string[]): void {
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      this.entries.push({ seq: this.nextSeq++, line, bytes });
      this.bytes += bytes;
    }
    while (this.entries.length > 1 && (this.bytes > this.maxBytes || this.entries.length > this.maxLines)) {
      const e = this.entries.shift()!;
      this.bytes -= e.bytes;
      this.firstSeq = e.seq + 1;
    }
  }

  /** `after` dan boshlab (<= `limit` qator). `dropped` = bufer tashlagan + agent tashlagan qatorlar (`after` dan beri). */
  read(after: number, limit: number = LOG_LIMITS.readPageLines): { lines: string[]; nextSeq: number; dropped: number } {
    const start = Math.max(after, this.firstSeq);
    const idx = this.entries.findIndex((e) => e.seq >= start);
    const slice = idx === -1 ? [] : this.entries.slice(idx, idx + limit);
    const nextSeq = slice.length > 0 ? slice[slice.length - 1]!.seq + 1 : Math.min(Math.max(after, this.firstSeq), this.nextSeq);
    let dropped = after < this.firstSeq ? this.firstSeq - after : 0;
    for (const g of this.gaps) if (g.atSeq >= after && g.atSeq <= nextSeq) dropped += g.n;
    return { lines: slice.map((e) => e.line), nextSeq, dropped };
  }
}
