import { describe, expect, it } from 'vitest';
import { LogBuffer } from './logs-buffer.js';

describe('LogBuffer', () => {
  it('qatorlarni cursor bilan o\'qiydi', () => {
    const b = new LogBuffer();
    b.append(['a', 'b', 'c']);
    expect(b.read(0)).toEqual({ lines: ['a', 'b', 'c'], nextSeq: 3, dropped: 0 });
    b.append(['d']);
    expect(b.read(3)).toEqual({ lines: ['d'], nextSeq: 4, dropped: 0 });
    expect(b.read(4)).toEqual({ lines: [], nextSeq: 4, dropped: 0 });
  });

  it('qator chegarasi: eskilari tashlanadi, dropped hisoblanadi', () => {
    const b = new LogBuffer({ maxLines: 3 });
    b.append(['1', '2', '3', '4', '5']);
    expect(b.size).toBe(3);
    const r = b.read(0);
    expect(r.lines).toEqual(['3', '4', '5']);
    expect(r.dropped).toBe(2);
    expect(r.nextSeq).toBe(5);
    // allaqachon 3 gacha o'qigan klient hech narsa yo'qotmagan
    expect(b.read(3)).toEqual({ lines: ['4', '5'], nextSeq: 5, dropped: 0 });
  });

  it('bayt chegarasi', () => {
    const b = new LogBuffer({ maxBytes: 20 });
    b.append(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']); // 9 bayt har biri
    expect(b.byteSize).toBeLessThanOrEqual(20);
    expect(b.read(0).lines).toEqual(['bbbbbbbb', 'cccccccc']);
  });

  it('bitta juda katta qator bufer bo\'sh qolmasligi uchun saqlanadi', () => {
    const b = new LogBuffer({ maxBytes: 5 });
    b.append(['x'.repeat(100)]);
    expect(b.size).toBe(1);
  });

  it('agent tashlagan qatorlar dropped ga qo\'shiladi (faqat o\'qilmagan oraliq uchun)', () => {
    const b = new LogBuffer();
    b.append(['a', 'b']);
    b.noteAgentDrop(7);
    b.append(['c']);
    expect(b.read(0).dropped).toBe(7);
    expect(b.read(2).dropped).toBe(7); // bo'shliq 2-seq oldidan edi
    expect(b.read(3).dropped).toBe(0);
  });

  it('read limiti', () => {
    const b = new LogBuffer();
    b.append(Array.from({ length: 10 }, (_, i) => String(i)));
    const r = b.read(0, 4);
    expect(r.lines).toEqual(['0', '1', '2', '3']);
    expect(r.nextSeq).toBe(4);
    expect(b.read(r.nextSeq, 100).lines.length).toBe(6);
  });
});
